"""Model-variable semantics used by the simulator and its PK summaries.

The parser can determine how a symbol is produced, but it cannot determine its
physical dimension from a name or from syntax alone.  For example, both ``Q1``
and ``C1`` are derived expressions, while only ``C1`` is a concentration.
Consequently structural classification and user-declared physical semantics are
kept as separate fields.
"""

import ast
from typing import Dict, Mapping, Optional


STRUCTURAL_CLASSES = {"compartment", "secondary_parameter", "derived_output"}
QUANTITY_KINDS = {"unknown", "concentration", "amount", "flow", "fraction", "other"}
PK_SCOPES = {"none", "exposure", "dose_normalized"}

# 옛 이름.  "exposure" 와 "systemic" 을 나란히 놓으면 PK 어휘와 충돌한다 —
# systemic exposure 는 원래 Cmax/AUC 를 가리키는 한 낱말이므로, 둘을 대립하는
# 선택지로 쓰면 "이 변수가 전신 농도인가"를 묻는 것처럼 읽힌다.  실제로 이
# 값이 가르는 것은 그게 아니라 "용량을 넘겨 CL·Vz 까지 낼 것인가" 하나다.
# 이미 저장된 세션이 옛 이름을 보내올 수 있으므로 조용히 새 이름으로 옮긴다.
_LEGACY_PK_SCOPES = {"systemic": "dose_normalized"}


def _names(expression: str) -> set[str]:
    """Return actual identifier references from a validated model expression."""
    tree = ast.parse(expression, mode="eval")
    return {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}


def structural_classes(parsed: Mapping) -> Dict[str, str]:
    """Classify variables by where their values come from, not by units.

    A derived definition is a secondary parameter when it depends only on base
    parameters and other secondary parameters.  It is a derived output when its
    dependency chain reaches a compartment or time.
    """
    compartments = list(parsed.get("compartments", []))
    compartment_set = set(compartments)
    derived = dict(parsed.get("derived_expressions", {}))
    dependencies = {name: _names(expr) for name, expr in derived.items()}
    memo: Dict[str, bool] = {}

    def depends_on_profile(name: str, visiting: set[str]) -> bool:
        if name in memo:
            return memo[name]
        if name in visiting:
            # The parser rejects cycles.  Keep the fallback conservative if a
            # caller supplies a hand-built parsed dictionary.
            return True
        refs = dependencies.get(name, set())
        answer = bool(refs & compartment_set or "t" in refs)
        if not answer:
            answer = any(
                depends_on_profile(ref, visiting | {name})
                for ref in refs
                if ref in derived
            )
        memo[name] = answer
        return answer

    result = {name: "compartment" for name in compartments}
    for name in derived:
        result[name] = (
            "derived_output" if depends_on_profile(name, set())
            else "secondary_parameter"
        )
    return result


def resolve_variable_semantics(
    parsed: Mapping,
    supplied: Optional[Mapping] = None,
) -> Dict[str, Dict[str, str]]:
    """Merge safe defaults with user declarations and validate the contract.

    No physical meaning is inferred.  Every variable starts as ``unknown`` with
    no PK scope until the user explicitly classifies it.
    """
    structures = structural_classes(parsed)
    supplied = supplied or {}
    if not isinstance(supplied, Mapping):
        raise ValueError("variable_semantics must be an object keyed by variable name.")

    result: Dict[str, Dict[str, str]] = {}
    for name, structural_class in structures.items():
        raw = supplied.get(name) or {}
        if not isinstance(raw, Mapping):
            raise ValueError(f"Semantics for '{name}' must be an object.")

        quantity_kind = str(raw.get("quantity_kind") or "unknown")
        pk_scope = str(raw.get("pk_scope") or "none")
        pk_scope = _LEGACY_PK_SCOPES.get(pk_scope, pk_scope)
        if quantity_kind not in QUANTITY_KINDS:
            raise ValueError(
                f"Unknown quantity kind '{quantity_kind}' for '{name}'."
            )
        if pk_scope not in PK_SCOPES:
            raise ValueError(f"Unknown PK scope '{pk_scope}' for '{name}'.")
        if pk_scope != "none" and quantity_kind != "concentration":
            raise ValueError(
                f"'{name}' can have PK scope only when it is a concentration."
            )

        result[name] = {
            "structural_class": structural_class,
            "quantity_kind": quantity_kind,
            "pk_scope": pk_scope,
        }
    return result

