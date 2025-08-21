from django.urls import path
from . import views

urlpatterns = [
    # Welcome 페이지
    path('', views.welcome, name='welcome'),
    # 오전 세션 페이지
    path('morning/', views.morning_session, name='morning_session'),
    path('qna/', views.qna_view, name='qna'),
    path('api/qna/', views.qna_api, name='qna_api'),
]
