from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path("parse/", views.parse_ode_view, name="parse_ode"),
    path('simulate/', views.simulate, name='simulate'),  # POST로 받을 API endpoint
]
