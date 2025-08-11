from django.shortcuts import render

def welcome(request):
    """Welcome 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/welcome.html')

def morning_session(request):
    """오전 세션 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/morning_session.html')

