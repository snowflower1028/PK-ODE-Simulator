from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path("parse/", views.parse_ode_view, name="parse_ode"),
    path("fit/", views.fit, name="fit"),
    path('simulate/', views.simulate, name='simulate'),  # POST로 받을 API endpoint
    path('sweep/', views.sweep, name='sweep'),           # 파라미터 하나를 훑는 민감도 분석

    # NCA 계산기 — 시뮬레이터와 별개의 페이지다.
    path('nca/', views.nca_page, name='nca'),
    path('nca/run/', views.nca_run, name='nca_run'),
    path('nca/units/', views.nca_units, name='nca_units'),
]
