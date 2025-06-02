import re
from typing import List, Dict, Any
from sympy import (
    symbols, sqrt, sin, cos, tan, exp, log, Abs,
    asin, acos, atan, sinh, cosh, tanh, sympify
)
from sympy.parsing.sympy_parser import parse_expr

def parse_ode_input(text: str) -> Dict[str, Any]:
    compartments = set()
    rhs_expressions = []
    param_definitions = {}
    evaluated_params = {}
    derived_expr = {}

    builtin_functions = {
        'sqrt': sqrt, 'sin': sin, 'cos': cos, 'tan': tan, 'exp': exp, 'log': log, 'ln': log,
        'abs': Abs, 'asin': asin, 'acos': acos, 'atan': atan,
        'sinh': sinh, 'cosh': cosh, 'tanh': tanh
    }

    # "^" → "**" 로 치환
    text = text.replace("^", "**")
    lines = [line.strip() for line in text.strip().split("\n") if line.strip()]

    # 1차 구문 분석
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

    # 수식에서 등장한 심볼 추출
    all_rhs_symbols = set()
    for rhs in rhs_expressions:
        all_rhs_symbols.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", rhs))

    parameters = all_rhs_symbols - compartments - builtin_functions.keys()
    symbol_table = {s: symbols(s) for s in compartments.union(parameters)}
    symbol_table.update(builtin_functions)

    # 파라미터 정의 처리
    for p, expr in param_definitions.items():
        try:
            parsed = parse_expr(expr, local_dict=symbol_table)
            free_syms = parsed.free_symbols

            if free_syms & set(symbols(list(compartments))) or 't' in expr:
                # compartment 또는 시간에 의존하면 동적 파라미터
                derived_expr[p] = expr
                for s in free_syms:
                    parameters.add(str(s))  # 사용된 원 파라미터 추가
                parameters.discard(p)      # 본인은 제거
                derived_expr[p] = str(parsed)  # 문자열로 저장
            else:
                evaluated = float(parsed.evalf())
                evaluated_params[p] = evaluated
                symbol_table[p] = evaluated
                for s in free_syms:
                    parameters.add(str(s))  # 사용된 파라미터는 유지
                parameters.discard(p)

        except Exception:
            derived_expr[p] = expr
            for s in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expr):
                parameters.add(s)
            parameters.discard(p)

    # ODE 수식 내 파라미터 치환
    substituted_ode_lines = []
    for line in lines:
        if "=" not in line:
            continue
        lhs, rhs = map(str.strip, line.split("=", 1))
        if re.match(r"^d([A-Za-z0-9_]+)dt$", lhs):
            for p, val in evaluated_params.items():
                rhs = re.sub(rf"\b{p}\b", str(val), rhs)
            for p, expr in derived_expr.items():
                rhs = re.sub(rf"\b{p}\b", f"({expr})", rhs)
            substituted_ode_lines.append(f"{lhs} = {rhs}")

    # SymPy 식으로 변환
    equations = {}
    for line in substituted_ode_lines:
        lhs, rhs = map(str.strip, line.split("=", 1))
        comp = re.match(r"^d([A-Za-z0-9_]+)dt$", lhs).group(1)
        equations[comp] = parse_expr(rhs, local_dict=symbol_table)

    res ={
        "compartments": sorted(compartments),
        "parameters": sorted(parameters),
        "derived_expressions": derived_expr,
        "processed_ode": "\n".join(substituted_ode_lines),
        "equations": equations
    }

    print(res)
    return res 
