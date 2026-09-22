"""
URL configuration for pk_simulator project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    # /admin/ 은 두지 않는다. 이 앱은 모델도 관리자 계정도 없어 쓸 데가 없는데,
    # 열어 두면 누구나 로그인 폼을 두드릴 수 있고 시도마다 PBKDF2 해시(수십 ms)를
    # 계산하게 된다 — 워커 2개짜리 서비스에서는 그 자체로 부하가 된다.
    path('', include('simulator.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)

    