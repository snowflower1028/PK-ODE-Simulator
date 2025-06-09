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
import re
from collections import defaultdict, deque
from typing import Dict, List, Set, Tuple, Any

from sympy import (
    symbols, sqrt, sin, cos, tan, exp, log, Abs,
    asin, acos, atan, sinh, cosh, tanh, parse_expr, Expr
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

# ───────────────────────────────────────────────
# 1. 전처리 & 행 분류
# ───────────────────────────────────────────────
def _preprocess(text: str) -> List[str]:
    """^→**, 비 ASCII 제거, 빈 줄 제거"""
    clean = []
    for ln in text.splitlines():
        ln = re.sub(r"[^\x00-\x7F]+", "", ln)  # 비 ASCII 삭제
        ln = ln.strip()
        if ln:
            clean.append(ln.replace("^", "**"))
    return clean

def _classify(lines: List[str]):
    """ODE 행·파라미터 정의 행 분리"""
    ode_rows, param_rows = [], {}
    for ln in lines:
        if "=" not in ln:
            continue
        lhs, rhs = map(str.strip, ln.split("=", 1))
        if (m := ODE_PAT.match(lhs)):
            ode_rows.append((m.group(1), rhs))
        elif PNAME_PAT.match(lhs):
            param_rows[lhs] = rhs
    return ode_rows, param_rows

# ───────────────────────────────────────────────
# 2. 심볼 테이블 초기 구축
# ───────────────────────────────────────────────
def _initial_symbols(ode_rows, param_rows):
    comps = {c for c, _ in ode_rows}
    token_rx = re.compile(r"[A-Za-z_][\w]*")
    tokens: Set[str] = set()
    for _, rhs in ode_rows:
        tokens.update(token_rx.findall(rhs))
    for rhs in param_rows.values():
        tokens.update(token_rx.findall(rhs))

    # 정의된 파라미터 심볼 포함
    param_syms = tokens - comps - _BUILTIN.keys()
    symtbl     = {s: symbols(s) for s in comps.union(param_syms)}
    symtbl.update(_BUILTIN)
    return comps, param_syms, symtbl

# ───────────────────────────────────────────────
# 3. 파라미터 RHS 파싱 + 의존성 그래프
# ───────────────────────────────────────────────
def _parse_param_defs(param_rows, symtbl):
    parsed, graph, rev = {}, defaultdict(set), defaultdict(set)
    for p, expr in param_rows.items():
        try:
            pe = parse_expr(expr, local_dict=symtbl)
            parsed[p] = pe
            deps = {str(s) for s in pe.free_symbols if str(s) != "t"}
            graph[p] = deps
            for d in deps:
                rev[d].add(p)
        except Exception:
            parsed[p] = None          # 파싱 실패 → 값 미정 (숫자 오류 등)
    return parsed, graph, rev

def _topo(graph, rev):
    nodes = set(graph) | {d for deps in graph.values() for d in deps}
    indeg = {n: 0 for n in nodes}
    for deps in graph.values():
        for d in deps:
            indeg[d] += 1
    q = deque([n for n in nodes if indeg[n] == 0])
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for nb in rev.get(n, []):
            indeg[nb] -= 1
            if indeg[nb] == 0:
                q.append(nb)
    return order

# ───────────────────────────────────────────────
# 4. 파생/입력 구분
# ───────────────────────────────────────────────
def _categorize(param_rows, topo_order, parsed_defs,
                symtbl, comps) -> Tuple[Set[str], Dict[str,str]]:
    defined_syms = set(param_rows)           # LHS 등장 → 파생으로 고정
    derived: Dict[str,str] = {k: v for k, v in param_rows.items()}  # 일괄 등록
    base: Set[str] = set()

    # 위상 정렬 순서대로 정적 파생 수치 평가(원할 때)
    for p in topo_order:
        if p not in defined_syms:
            continue
        expr = parsed_defs.get(p)
        if expr is None:
            continue
        fsyms = {str(s) for s in expr.free_symbols}
        if fsyms <= symtbl.keys():
            symtbl[p] = expr              # 정적 파생 값 갱신

    # 입력 파라미터 = 모든 심볼 후보 ─ 컴파트먼트 ─ 파생
    all_syms = set(symtbl) - comps - _BUILTIN.keys()
    base = all_syms - defined_syms
    return base, derived

# ───────────────────────────────────────────────
# 5. ODE 치환 & SymPy 방정식
# ───────────────────────────────────────────────
def _substitute_odes(ode_rows, derived, symtbl):
    out = []
    # 1. 먼저 SymPy expr 로 파생 dict 구성
    derived_sympy = {symbols(k): parse_expr(v, local_dict=symtbl)
                     for k, v in derived.items()}

    for comp, rhs in ode_rows:
        expr = parse_expr(rhs, local_dict=symtbl)
        # 2. 재귀 치환: derived 기호가 없어질 때까지 반복
        prev_free = None
        while prev_free != expr.free_symbols & derived_sympy.keys():
            prev_free = expr.free_symbols & derived_sympy.keys()
            expr = expr.xreplace(derived_sympy)
        out.append(f"d{comp}dt = {expr}")
    return out

def _build_eq(proc_lines, symtbl):
    eq = {}
    for ln in proc_lines:
        lhs, rhs = map(str.strip, ln.split("=", 1))
        comp = ODE_PAT.match(lhs).group(1)
        eq[comp] = parse_expr(rhs, local_dict=symtbl)
    return eq

# ───────────────────────────────────────────────
# 6. 메인 엔트리
# ───────────────────────────────────────────────
def parse_ode_input(text: str) -> Dict[str, Any]:
    lines                   = _preprocess(text)
    ode_rows, param_rows    = _classify(lines)

    comps, param_syms, symtbl = _initial_symbols(ode_rows, param_rows)
    parsed_defs, graph, rev   = _parse_param_defs(param_rows, symtbl)
    topo_order                = _topo(graph, rev)

    base_params, derived_exprs = _categorize(
        param_rows, topo_order, parsed_defs, symtbl, comps
    )

    proc_lines  = _substitute_odes(ode_rows, derived_exprs, symtbl)
    equations   = _build_eq(proc_lines, symtbl)

    # 최종 반환 딕셔너리. lambdify 관련 키는 제거됨.
    return {
        "compartments"        : sorted(comps),
        "parameters"          : sorted(base_params),
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
