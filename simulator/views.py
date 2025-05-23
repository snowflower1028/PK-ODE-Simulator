from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
from django.shortcuts import render
from .solver import simulate_custom_ode
import json


def index(request):
    return render(request, 'simulator/index.html')


@csrf_exempt
def simulate(request):
    if request.method == "POST":
        try:
            data = json.loads(request.body)

            result = simulate_custom_ode(
                equations_str=data["equations"],
                compartments=data["compartments"],
                parameters=data["parameters"],
                initials=data["initials"],
                doses=data["doses"],
                t_start=0,
                t_end=48
            )
            return JsonResponse({"status": "ok", "data": result})
        except Exception as e:
            return JsonResponse({"status": "error", "message": str(e)})
