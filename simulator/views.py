from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt
from django.shortcuts import render
import numpy as np
import json

from .parser import parse_ode_input
from .solver import solve_ode_system
from .analyzer import analyze_pk


@csrf_exempt
def simulate(request):
    if request.method == "POST":
        try:
            data = json.loads(request.body)

            # 1. 사용자 입력에서 수식 및 값 추출
            init_values = data.get("initials", {})
            param_values = data.get("parameters", {})
            t_start = float(data.get("t_start", 0))
            t_end = float(data.get("t_end", 48))
            t_steps = int(data.get("t_steps", 200))
            t_eval = np.linspace(t_start, t_end, t_steps)
            doses = data.get("doses", [])

            # 2. 수식 파싱 (parser.py 사용, JavaScript에서 전달된 ODE 텍스트)
            # parse_ode_input은 equation 텍스트만 파싱
            parsed = parse_ode_input(data.get("equations", ""))

            equations = parsed["equations"]             # dict
            compartments = parsed["compartments"]       # list
            parameters = parsed["parameters"]           # list

            # 3. solver.py 사용하여 시뮬레이션 수행
            df = solve_ode_system(
                equations=equations,
                compartments=compartments,
                parameters=parameters,
                init_values=init_values,
                param_values=param_values,
                t_span=[t_start, t_end],
                t_eval=t_eval,
                doses=doses
            )

            # 4. analyzer.py 사용하여 PK 파라미터 계산
            pk_summary = analyze_pk(df, compartments)

            # 필터링: 선택된 compartment만 포함
            selected_comps = data.get("compartments", compartments)
            filtered_df = df[["Time"] + selected_comps]
            filtered_pk = {k: v for k, v in pk_summary.items() if k in selected_comps}            

            # 5. JSON 응답 반환
            return JsonResponse({
                "status": "ok",
                "data": {
                    "profile": filtered_df.to_dict(orient="list"),
                    "pk": filtered_pk
                }
            })

        except Exception as e:
            import traceback
            traceback.print_exc()  # 서버 콘솔로 예외 출력
            return JsonResponse({"status": "error", "message": str(e)})

    else:
        return JsonResponse({"status": "error", "message": "Invalid request method"})

@require_POST
def parse_ode_view(request):
    import json
    data = json.loads(request.body)
    ode_text = data.get("text", "")

    parsed = parse_ode_input(ode_text)
    equations_for_response = {k: str(v) for k, v in parsed["equations"].items()}

    return JsonResponse({
        "status": "ok",
        "data": {
            **parsed,
            "equations": equations_for_response
        }
    })

def index(request):
    return render(request, "simulator/index.html")

