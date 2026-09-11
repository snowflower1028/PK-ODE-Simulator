"""파생 변수(derived expression) 평가 — 단일 구현.

이전에는 이 로직이 네 군데에 복사돼 있었고(`views._solve_profile`,
`views.simulate`, `fitting._predict_pairs`, `fitting` 의 프로필 재계산),
그중 셋이 방금 계산한 파생 컬럼을 다음 식의 환경에 되먹이지 않았다.  그래서

    fd2 = 1-fd1
    Q2  = fd2 * QCO

같은 연쇄가 `Q2` 에서 조용히 실패했다.  `/simulate/` 는 HTTP 200 으로 `Q2` 만
빠뜨린 프로필을 돌려줬고, 피팅 쪽 두 곳은 예외를 통째로 삼켜서 관측 매핑이
해소되지 않은 채 "성공"을 보고할 수 있었다.

여기서는 한 번만 구현하고, 실패를 삼키지 않고 호출자에게 돌려준다.

왜 `pd.eval` 을 쓰지 않는가
---------------------------
처음에는 `pd.eval(expr, local_dict=env, engine="python")` 이었다.  `engine`
이름 때문에 안전해 보이지만 문법을 제한하는 것은 engine 이 아니라 parser 이고,
기본 parser("pandas")는 속성 접근을 명시적으로 허용한다.  실제로 확인해 보면
`pd.compat.os.system("...")` 이 그대로 실행된다 — `derived.py` 의 모듈
전역까지 이름 해소 대상이기 때문이다.

오늘 그것이 터지지 않는 이유는 여기 들어오는 문자열이 전부
`parser._safe_parse_expr` 를 이미 통과했기 때문뿐이다.  즉 익명의 HTTP 본문과
`os.system` 사이에 `isinstance` 분기 하나가 서 있는 셈이고, 앞으로 누군가
검증을 거치지 않은 식을 여기로 넘기거나 검증을 느슨하게 하면 그 자리에서
원격 코드 실행이 된다.

그래서 텍스트를 다시 파이썬 문법으로 해석하지 않는다.  파서가 이미 쓰는
화이트리스트(`_safe_parse_expr`)로 SymPy 식을 만들고, `lambdify` 로 수치
함수를 뽑아 numpy 배열에 적용한다.  같은 식이 반복해서 들어오므로(피팅은
목적함수 평가마다 부른다) 컴파일 결과를 캐시한다.
"""

from functools import lru_cache
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import numpy as np
import pandas as pd
from sympy import lambdify, symbols

from .parser import _BUILTIN, _expression_names, _safe_parse_expr


#: 컴파일된 식을 얼마나 들고 있을지.  하나가 작은 클로저라 넉넉히 잡아도
#: 부담이 없고, 피팅 한 번이 같은 식을 수백 번 부른다.
_COMPILE_CACHE_SIZE = 512


@lru_cache(maxsize=_COMPILE_CACHE_SIZE)
def _compile(expression: str) -> Tuple[Tuple[str, ...], Callable]:
    """식 하나를 수치 함수로 바꾼다. 인자 이름과 함께 돌려준다.

    `_safe_parse_expr` 가 허용하는 문법만 통과한다 — 속성 접근, 인덱싱,
    화이트리스트 밖의 호출은 여기서 ValueError 가 된다.
    """
    # `_expression_names` 는 호출 대상까지 이름으로 돌려준다 — `sqrt(A1)` 이면
    # sqrt 와 A1 둘 다. 함수 이름은 인자가 아니므로 걸러 낸다. 걸러 내지 않으면
    # "sqrt 라는 열이 없다"며 멀쩡한 식이 실패한다.
    names = tuple(n for n in _expression_names(expression) if n not in _BUILTIN)
    symtbl = {name: symbols(name) for name in names}
    expr = _safe_parse_expr(expression, symtbl)
    func = lambdify([symtbl[name] for name in names], expr, modules="numpy")
    return names, func


def _as_values(value: Any, length: int) -> np.ndarray:
    """스칼라든 열이든 길이가 맞는 배열로 만든다."""
    array = np.asarray(value, dtype=float)
    if array.ndim == 0:
        return np.full(length, float(array))
    return array


def attach_derived(
    df: pd.DataFrame,
    derived_expressions: Optional[Mapping[str, str]],
    extra_env: Optional[Mapping[str, Any]] = None,
) -> Tuple[pd.DataFrame, List[Dict[str, str]]]:
    """`df` 에 파생 변수 컬럼을 의존성 순서대로 붙인다.

    선언 순서에 기대지 않는다.  한 바퀴 돌며 계산되는 것을 모두 계산하고,
    한 바퀴에 하나도 진전이 없으면 남은 것을 실패로 확정한다.  파서가 위상정렬을
    해 주더라도, 순서가 틀어진 입력이나 향후 변경에 대해 이쪽이 더 안전하다.

    Returns
    -------
    (df, failures)
        `failures` 는 `{"name", "expression", "error"}` 딕셔너리의 리스트다.
        비어 있으면 전부 계산됐다는 뜻이다.
    """
    failures: List[Dict[str, str]] = []
    if not derived_expressions:
        return df, failures

    env: Dict[str, Any] = {column: df[column].to_numpy() for column in df.columns}
    if extra_env:
        env.update(extra_env)
    length = len(df)

    pending = dict(derived_expressions)
    while pending:
        still: Dict[str, str] = {}
        errors: Dict[str, str] = {}
        progressed = False

        for name, expression in pending.items():
            try:
                arg_names, func = _compile(expression)
                missing = [n for n in arg_names if n not in env]
                if missing:
                    raise NameError(
                        f"{', '.join(missing)} is not available yet"
                        if len(missing) == 1
                        else f"{', '.join(missing)} are not available yet"
                    )
                value = func(*(_as_values(env[n], length) for n in arg_names))
            except Exception as exc:  # noqa: BLE001 - 사용자 식이라 무엇이든 올 수 있다
                still[name] = expression
                errors[name] = f"{type(exc).__name__}: {exc}"
                continue

            df[name] = _as_values(value, length)
            env[name] = df[name].to_numpy()
            progressed = True

        if not progressed:
            # 남은 것들은 서로/외부 심볼에 막혀 있다. 더 돌아도 진전이 없다.
            for name, expression in still.items():
                failures.append(
                    {"name": name, "expression": expression, "error": errors[name]}
                )
            break

        pending = still

    return df, failures


def describe_failures(failures: List[Dict[str, str]]) -> List[str]:
    """로그/응답에 싣기 좋은 한 줄 문자열로 바꾼다."""
    return [
        f"{f['name']} = {f['expression']}  ({f['error']})" for f in failures
    ]
