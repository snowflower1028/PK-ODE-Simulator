from typing import Dict, List, Any
from sympy import symbols, sympify, Expr
import re


def parse_odes(ode_text: str) -> Dict[str, Any]:
    """
    Parse a set of ODE equations given as a multiline string and extract compartments, parameters, and expressions.

    Parameters
    ----------
    ode_text : str
        Multiline string of ODEs where each line follows the format 'd<CompartmentName>dt = <Expression>'.

    Returns
    -------
    Dict[str, Any]
        A dictionary with the following keys:
        - 'equations': Dict[str, Expr], mapping of compartment name to sympy expression
        - 'compartments': List[str], list of compartment names
        - 'parameters': List[str], list of parameter names
    """
    equations: Dict[str, Expr] = {}
    compartments: List[str] = []
    parameters = set()

    print("Python Parser Called")
    # Clean and split input into lines
    lines = [line.strip() for line in ode_text.strip().split('\n') if line.strip()]

    for line in lines:
        if '=' not in line:
            continue  # Skip invalid lines
        lhs, rhs = map(str.strip, line.split('=', 1))

        # Extract compartment name from left-hand side (e.g., dCdt → C)
        match = re.match(r'd([a-zA-Z_][a-zA-Z0-9_]*)dt', lhs)
        if not match:
            raise ValueError(f"Invalid LHS format in line: {line}")
        comp_name = match.group(1)
        compartments.append(comp_name)

        # Convert RHS to sympy expression
        expr = sympify(rhs)
        equations[comp_name] = expr

    # Identify parameters by subtracting compartments from all symbols
    all_symbols = set().union(*[expr.free_symbols for expr in equations.values()])
    compartment_syms = set(symbols(compartments))
    parameters = all_symbols - compartment_syms

    return {
        "equations": equations,
        "compartments": compartments,
        "parameters": sorted([str(p) for p in parameters])
    }


if __name__ == "__main__":
    ode_text = """
    dCdt = -kel * C - kon * C * R + koff * CR
    dRdt = -kon * C * R + koff * CR + kdeg * CR
    dCRdt = kon * C * R - koff * CR - kint * CR
    """
    parsed = parse_odes(ode_text)
    print(parsed)

