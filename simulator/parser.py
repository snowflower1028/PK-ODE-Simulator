import re
from typing import List, Dict
from sympy.parsing.sympy_parser import parse_expr
from sympy import symbols, sqrt, sympify


def parse_ode_input(text: str) -> Dict:
    lines = [line.strip() for line in text.strip().split("\n") if line.strip()]
    compartments = set()
    rhs_expressions = []
    param_definitions = {}

    # 수식 내 특수 문자 치환        
    text = text.replace("^", "**")
    lines = [line.strip() for line in text.strip().split("\n") if line.strip()]

    # 1. 좌변 구문 분석
    for line in lines:
        if "=" not in line:
            continue
        lhs, rhs = map(str.strip, line.split("=", 1))
        match = re.match(r"^d([A-Za-z0-9_]+)dt$", lhs)
        if match:
            comp = match.group(1)
            compartments.add(comp)
            rhs_expressions.append(rhs)
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", lhs):
            param_definitions[lhs] = rhs

    # 2. 우변에서 등장한 모든 symbol 추출
    all_rhs_symbols = set()
    for rhs in rhs_expressions:
        all_rhs_symbols.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", rhs))

    parameters = all_rhs_symbols - compartments

    # 3. 동적 파라미터 추출 및 ODE 내 수식 치환
    substituted_ode_lines = []
    derived_expr = {}

    for line in lines:
        if "=" not in line:
            continue
        lhs, rhs = map(str.strip, line.split("=", 1))
        match = re.match(r"^d([A-Za-z0-9_]+)dt$", lhs)
        if match:
            # 수식 파라미터 치환
            for p, expr in param_definitions.items():
                if any(c in expr for c in compartments) or "t" in expr:
                    rhs = re.sub(rf"\b{p}\b", f"({expr})", rhs)
                    derived_expr[p] = expr
                    parameters.discard(p)
            substituted_ode_lines.append(f"{lhs} = {rhs}")

    processed_ode = "\n".join(substituted_ode_lines)

    # 4. sympy용 symbol 테이블 생성
    symbol_table = {s: symbols(s) for s in compartments.union(parameters)}
    symbol_table['sqrt'] = sqrt  # 함수 등록

    # 5. sympy로 파싱된 ODE dict 생성
    equations = {}
    for line in substituted_ode_lines:
        lhs, rhs = map(str.strip, line.split("=", 1))
        comp = re.match(r"^d([A-Za-z0-9_]+)dt$", lhs).group(1)
        equations[comp] = parse_expr(rhs, local_dict=symbol_table)

    return {
        "compartments": sorted(compartments),
        "parameters": sorted(parameters),
        "derived_expressions": derived_expr,
        "processed_ode": processed_ode,
        "equations": equations
    }
