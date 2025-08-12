import os
import pandas as pd
import numpy as np
from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
import traceback

def welcome(request):
    """Welcome 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/welcome.html')

def morning_session(request):
    """오전 세션 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/morning_session.html')
