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
"""

from typing import Any, Dict, List, Mapping, Optional, Tuple

import pandas as pd


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

    env: Dict[str, Any] = df.to_dict(orient="series")
    if extra_env:
        env.update(extra_env)

    pending = dict(derived_expressions)
    while pending:
        still: Dict[str, str] = {}
        errors: Dict[str, str] = {}
        progressed = False

        for name, expr in pending.items():
            try:
                value = pd.eval(expr, local_dict=env, engine="python")
            except Exception as exc:  # noqa: BLE001 - 사용자 식이라 무엇이든 올 수 있다
                still[name] = expr
                errors[name] = f"{type(exc).__name__}: {exc}"
                continue
            df[name] = value
            env[name] = df[name]
            progressed = True

        if not progressed:
            # 남은 것들은 서로/외부 심볼에 막혀 있다. 더 돌아도 진전이 없다.
            for name, expr in still.items():
                failures.append(
                    {"name": name, "expression": expr, "error": errors[name]}
                )
            break

        pending = still

    return df, failures


def describe_failures(failures: List[Dict[str, str]]) -> List[str]:
    """로그/응답에 싣기 좋은 한 줄 문자열로 바꾼다."""
    return [
        f"{f['name']} = {f['expression']}  ({f['error']})" for f in failures
    ]
