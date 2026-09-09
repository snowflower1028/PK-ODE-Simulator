"""
parser.py  ──  ODE 텍스트 → JSON-ready 파싱 결과
───────────────────────────────────────────────
출력:
  compartments        : List[str]
  parameters          : List[str]          (사용자 입력 대상)
  derived_expressions : Dict[str,str]      (자동 계산·표기용)
  processed_ode       : str                (파생 치환된 텍스트)
  equations           : Dict[str,Expr]     (SymPy 수치식)
"""
import ast
import re
from collections import defaultdict, deque
from typing import Dict, List, Set, Tuple, Any

from sympy import (
    symbols, sqrt, sin, cos, tan, exp, log, Abs,
    asin, acos, atan, sinh, cosh, tanh, Expr, Float, Integer, Rational
)

# ───────────────────────────────────────────────
# 0. 상수 & 정규식
# ───────────────────────────────────────────────
_BUILTIN = {
    'sqrt': sqrt, 'sin': sin, 'cos': cos, 'tan': tan,
    'exp': exp,   'log': log, 'ln': log, 'abs': Abs,
    'asin': asin, 'acos': acos, 'atan': atan,
    'sinh': sinh, 'cosh': cosh, 'tanh': tanh,
}
ODE_PAT   = re.compile(r"^d([A-Za-z_][\w]*)dt$")
PNAME_PAT = re.compile(r"^[A-Za-z_][\w]*$")
_RESERVED = {"t", "Time"}
_MAX_TEXT_LENGTH = 50_000
_MAX_EXPR_NODES = 1_000
_UNICODE_TRANSLATION = str.maketrans({
    "−": "-",  # mathematical minus
    "–": "-",  # en dash copied in place of minus
    "—": "-",  # em dash copied in place of minus
    "×": "*",
    "÷": "/",
})

# ───────────────────────────────────────────────
# 1. 전처리 & 행 분류
# ───────────────────────────────────────────────
def _preprocess(text: str) -> List[str]:
    """수식에서 흔한 유니코드 연산자를 정규화하고 빈 줄을 제거한다.

    예전 구현은 모든 비 ASCII 문자를 삭제했다. 그러면 U+2212 minus가
    사라져 ``-k*A``가 ``k*A``로 바뀐다. 모르는 문자는 의미를 추측하지
    않고 오류로 돌려주는 편이 계산기에서는 안전하다.
    """
    if not isinstance(text, str):
        raise ValueError("ODE input must be text.")
    if len(text) > _MAX_TEXT_LENGTH:
        raise ValueError(f"ODE input is too long (maximum {_MAX_TEXT_LENGTH} characters).")

    clean = []
    for line_no, raw in enumerate(text.splitlines(), start=1):
        ln = raw.translate(_UNICODE_TRANSLATION)
        unsupported = next((ch for ch in ln if ord(ch) > 127), None)
        if unsupported is not None:
            raise ValueError(
                f"Unsupported character U+{ord(unsupported):04X} on line {line_no}; "
                "use ASCII names and operators."
            )
        # 간단한 끝줄 주석은 허용한다. 문자열 리터럴은 수식 문법에서 허용하지
        # 않으므로 '#' 뒤를 자르는 데 모호함이 없다.
        ln = ln.split("#", 1)[0]
        ln = ln.strip()
        if ln:
            clean.append(ln.replace("^", "**"))
    return clean

def _classify(lines: List[str]):
    """ODE 행·파라미터 정의 행 분리"""
    ode_rows, param_rows = [], {}
    seen_compartments = set()
    for line_no, ln in enumerate(lines, start=1):
        if "=" not in ln:
            raise ValueError(
                f"Expected 'name = expression' or 'dNamedt = expression' on line {line_no}."
            )
        lhs, rhs = map(str.strip, ln.split("=", 1))
        if not rhs:
            raise ValueError(f"Missing expression on line {line_no}.")
        if (m := ODE_PAT.match(lhs)):
            compartment = m.group(1)
            if compartment in seen_compartments:
                raise ValueError(f"Duplicate ODE for compartment '{compartment}'.")
            seen_compartments.add(compartment)
            ode_rows.append((compartment, rhs))
        elif PNAME_PAT.match(lhs):
            if lhs in param_rows:
                raise ValueError(f"Duplicate derived definition for '{lhs}'.")
            param_rows[lhs] = rhs
        else:
            raise ValueError(
                f"Invalid left-hand side '{lhs}' on line {line_no}; expected a name or dNamedt."
            )

    compartments = set(seen_compartments)
    defined = set(param_rows)
    overlap = compartments & defined
    if overlap:
        name = sorted(overlap)[0]
        raise ValueError(f"'{name}' cannot be both a compartment and a derived variable.")

    for name in compartments | defined:
        if name in _RESERVED:
            raise ValueError(f"'{name}' is reserved and cannot be defined by the model.")
        if name in _BUILTIN:
            raise ValueError(f"'{name}' is a built-in function name and cannot be redefined.")
    return ode_rows, param_rows


def _expression_tree(text: str) -> ast.Expression:
    """Python expression AST를 만들되 크기를 제한한다."""
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Invalid expression '{text}': {exc.msg}.") from exc
    if sum(1 for _ in ast.walk(tree)) > _MAX_EXPR_NODES:
        raise ValueError(f"Expression is too complex (maximum {_MAX_EXPR_NODES} syntax nodes).")
    return tree


def _expression_names(text: str) -> List[str]:
    """식에 실제 AST Name으로 등장하는 이름을 첫 등장 순서로 돌려준다.

    정규식과 달리 1e-3의 e를 이름으로 잘못 읽지 않는다.
    """
    tree = _expression_tree(text)
    names: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id not in names:
            names.append(node.id)
    return names


# 거듭제곱 하나가 워커를 죽일 수 있다.  sympy 는 정수 거듭제곱을 그 자리에서
# 계산하므로 `x = 2**10000` 다음 `y = x**10000` 이면 1억 비트짜리 정수가 되고,
# 파싱 도중 메모리가 바닥난다.  요청 하나로 서비스가 멈추는 셈이다.
# 지수만 보는 것으로는 부족하다 — 밑이 이미 거대할 수 있기 때문이다.
# 그래서 결과의 크기를 비트 수로 미리 어림해 막는다.
_MAX_RESULT_BITS = 4_096   # 약 1230 자리. 어떤 PK 모델도 이보다 크지 않다.


def _check_power(base, exponent) -> None:
    """`base ** exponent` 를 계산하기 전에 결과 크기를 어림한다."""
    if not exponent.is_number:
        return
    try:
        exp_value = float(exponent)
    except (TypeError, ValueError):
        return
    if abs(exp_value) > 10_000:
        raise ValueError("A numeric exponent is too large.")
    if not base.is_number:
        return
    try:
        base_bits = max(1, int(base.evalf(20)).bit_length())
    except (TypeError, ValueError, OverflowError):
        # 무한대나 계산할 수 없는 밑. 크기를 어림할 수 없으니 막는다.
        raise ValueError("This power is too large to evaluate.")
    if base_bits * abs(exp_value) > _MAX_RESULT_BITS:
        raise ValueError(
            "This power would produce a number too large to work with "
            f"(about {int(base_bits * abs(exp_value))} bits)."
        )


def _guard_number_size(expr, what: str):
    """식 안의 수 하나라도 감당 못 할 만큼 크면 거절한다.

    `_check_power` 는 파싱 시점에 판단하는데, 그때 밑은 아직 심볼일 수 있다::

        x1 = 2**1000      # 여기서는 1000비트, 통과
        x2 = x1**10000    # 밑이 심볼이라 검사할 것이 없다

    치환은 위상 순서로 일어나므로, 값이 정해지는 그 자리에서 다시 잰다.
    지수가 10000 으로, 밑이 4096비트로 묶여 있으니 한 단계가 만들 수 있는
    최악은 약 5 MB 다 — 만들어지긴 하지만 곧바로 거절되고 파싱이 멈춘다.
    """
    for number in expr.atoms(Integer, Rational, Float):
        try:
            if number.is_Integer:
                bits = int(number).bit_length()
            elif number.is_Rational:
                bits = max(abs(number.p).bit_length(), abs(number.q).bit_length())
            else:
                continue
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"{what} produces a number too large to work with.")
        if bits > _MAX_RESULT_BITS:
            raise ValueError(
                f"{what} produces a number too large to work with "
                f"(about {bits} bits)."
            )
    return expr


def _safe_parse_expr(text: str, symtbl: Dict[str, object]) -> Expr:
    """허용한 수학 문법만 SymPy 식으로 옮긴다.

    속성 접근·인덱싱·comprehension 등 Python 실행 문법은 받지 않는다.
    ``parse_expr``가 내부적으로 ``eval``을 쓰는 문제를 피하기 위해 AST를
    직접 순회한다.
    """
    tree = _expression_tree(text)

    def convert(node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("Only real numeric literals are allowed in ODE expressions.")
            return Integer(node.value) if isinstance(node.value, int) else Float(repr(node.value))

        if isinstance(node, ast.Name):
            if node.id not in symtbl:
                raise ValueError(f"Unknown symbol '{node.id}'.")
            value = symtbl[node.id]
            if value in _BUILTIN.values():
                raise ValueError(f"Function '{node.id}' must be called with parentheses.")
            return value

        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = convert(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value

        if isinstance(node, ast.BinOp):
            left, right = convert(node.left), convert(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.Pow):
                _check_power(left, right)
                return left ** right
            raise ValueError(f"Operator '{type(node.op).__name__}' is not allowed.")

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _BUILTIN:
                raise ValueError("Only the documented mathematical functions are allowed.")
            if node.keywords:
                raise ValueError("Keyword arguments are not allowed in ODE functions.")
            try:
                return _BUILTIN[node.func.id](*(convert(arg) for arg in node.args))
            except Exception as exc:
                raise ValueError(f"Invalid call to '{node.func.id}': {exc}") from exc

        raise ValueError(f"Syntax '{type(node).__name__}' is not allowed in ODE expressions.")

    return convert(tree.body)

# ───────────────────────────────────────────────
# 2. 심볼 테이블 초기 구축
# ───────────────────────────────────────────────
def _initial_symbols(ode_rows, param_rows):
    comps = {c for c, _ in ode_rows}
    tokens: Set[str] = set()
    # 사용자가 적은 순서(첫 등장 순서)를 함께 기록해 둔다.
    # UI 에서 "ODE 입력 순서"로 정렬해 보여주기 위한 정보이며, 계산에는 쓰이지 않는다.
    token_order: List[str] = []

    def _scan(text: str):
        for tok in _expression_names(text):
            tokens.add(tok)
            if tok not in token_order:
                token_order.append(tok)

    for _, rhs in ode_rows:
        _scan(rhs)
    for rhs in param_rows.values():
        _scan(rhs)

    # 정의문의 LHS도 심볼이어야 의존성 그래프와 치환에 쓸 수 있다.
    param_syms = (tokens | set(param_rows)) - comps - _BUILTIN.keys() - {"t"}
    if "Time" in param_syms:
        raise ValueError("'Time' is reserved for the output time column.")
    symtbl     = {s: symbols(s) for s in comps.union(param_syms)}
    symtbl["t"] = symbols("t")
    symtbl.update(_BUILTIN)
    return comps, param_syms, symtbl, token_order

# ───────────────────────────────────────────────
# 3. 파라미터 RHS 파싱 + 의존성 그래프
# ───────────────────────────────────────────────
def _parse_param_defs(param_rows, symtbl):
    parsed, graph, rev = {}, defaultdict(set), defaultdict(set)
    defined = set(param_rows)
    for p, expr in param_rows.items():
        pe = _safe_parse_expr(expr, symtbl)
        parsed[p] = pe
        deps = {str(s) for s in pe.free_symbols if str(s) in defined}
        graph[p] = deps
        for dependency in deps:
            rev[dependency].add(p)
    return parsed, graph, rev

def _topo(graph, rev):
    nodes = list(graph)
    indeg = {name: len(graph[name]) for name in nodes}
    q = deque([name for name in nodes if indeg[name] == 0])
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for nb in rev.get(n, []):
            indeg[nb] -= 1
            if indeg[nb] == 0:
                q.append(nb)
    if len(order) != len(nodes):
        cyclic = sorted(name for name in nodes if indeg[name] > 0)
        raise ValueError(f"Cyclic derived definition involving: {', '.join(cyclic)}.")
    return order

# ───────────────────────────────────────────────
# 4. 파생/입력 구분
# ───────────────────────────────────────────────
def _categorize(param_rows, topo_order, parsed_defs,
                symtbl, comps) -> Tuple[Set[str], Dict[str,str]]:
    defined_syms = set(param_rows)           # LHS 등장 → 파생으로 고정
    # Python dict의 순서를 위상 순서로 맞춰 모든 실행 경로가 의존 항목부터
    # 계산하도록 한다.
    derived: Dict[str,str] = {name: param_rows[name] for name in topo_order}

    # 입력 파라미터 = 모든 심볼 후보 ─ 컴파트먼트 ─ 파생
    all_syms = set(symtbl) - comps - _BUILTIN.keys() - {"t"}
    base = all_syms - defined_syms
    return base, derived

# ───────────────────────────────────────────────
# 5. ODE 치환 & SymPy 방정식
# ───────────────────────────────────────────────
def _substitute_odes(ode_rows, parsed_defs, topo_order, symtbl):
    """파생식을 dependency-first 순서로 한 번씩 치환한다."""
    resolved = {}
    for name in topo_order:
        resolved[symtbl[name]] = _guard_number_size(
            parsed_defs[name].xreplace(resolved), f"'{name}'"
        )

    out = []
    equations = {}
    for comp, rhs in ode_rows:
        expr = _guard_number_size(
            _safe_parse_expr(rhs, symtbl).xreplace(resolved), f"'d{comp}dt'"
        )
        equations[comp] = expr
        out.append(f"d{comp}dt = {expr}")
    return out, equations

# ───────────────────────────────────────────────
# 6. 메인 엔트리
# ───────────────────────────────────────────────
def parse_ode_input(text: str) -> Dict[str, Any]:
    lines                   = _preprocess(text)
    ode_rows, param_rows    = _classify(lines)

    comps, param_syms, symtbl, token_order = _initial_symbols(ode_rows, param_rows)
    parsed_defs, graph, rev   = _parse_param_defs(param_rows, symtbl)
    topo_order                = _topo(graph, rev)

    base_params, derived_exprs = _categorize(
        param_rows, topo_order, parsed_defs, symtbl, comps
    )

    proc_lines, equations = _substitute_odes(
        ode_rows, parsed_defs, topo_order, symtbl
    )

    # ── 표시 순서용 정보 ────────────────────────────
    # compartments/parameters 는 계산 경로가 의존하므로 기존대로 알파벳순을 유지하고,
    # "사용자가 ODE 에 적은 순서"는 별도 키로 함께 돌려준다.
    comp_order = []
    for c, _ in ode_rows:
        if c not in comp_order:
            comp_order.append(c)
    comp_order += [c for c in sorted(comps) if c not in comp_order]

    param_order = [t for t in token_order if t in base_params]
    param_order += [p for p in sorted(base_params) if p not in param_order]

    # 최종 반환 딕셔너리. lambdify 관련 키는 제거됨.
    return {
        "compartments"        : sorted(comps),
        "parameters"          : sorted(base_params),
        "compartments_ode_order": comp_order,
        "parameters_ode_order"  : param_order,
        "derived_expressions" : derived_exprs,
        "processed_ode"       : "\n".join(proc_lines),
        "equations"           : equations,
    }


# ───────────────────────────────────────────────
# test code
# ───────────────────────────────────────────────
if __name__ == "__main__":
    txt = """
    Kd = koff / kon
    Lc = 0.5*(Lctot - Rtot - Kd + sqrt((Lctot - Rtot - Kd)^2 + 4*Kd*Lctot))

    dLctotdt = -(kel + kpt)*Lc - (Rtot*kep*Lc)/(Kd+Lc) + ktp*Lt
    dRtotdt  = kin - kout*Rtot - (kep-kout)*(Rtot*Lc)/(Kd+Lc)
    dLtdt    = -ktp*Lt + kpt*Lc
    """
    out = parse_ode_input(txt)
    from pprint import pprint
    pprint(out)
