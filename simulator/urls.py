from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('simulate/', views.simulate, name='simulate'),  # POST로 받을 API endpoint
]
