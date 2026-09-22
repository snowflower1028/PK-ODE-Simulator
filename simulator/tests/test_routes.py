"""공개 경로 (T5a).

/admin/ 을 걷어 냈다. 이 앱에는 모델도 관리자 계정도 없어 쓸 데가 없었는데,
열려 있으면 누구나 로그인 폼을 두드릴 수 있고 시도마다 PBKDF2 해시를 계산한다.
"""
from django.test import SimpleTestCase, override_settings

#: 페이지를 그리려면 collectstatic 이 만든 매니페스트가 필요하다. 시험이 빌드
#: 산출물에 기대지 않도록 매니페스트 없는 저장소로 바꿔 둔다.
_PLAIN_STATIC = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}


@override_settings(STORAGES=_PLAIN_STATIC)
class 관리자_경로는_없다(SimpleTestCase):
    def test_404(self):
        for url in ("/admin/", "/admin/login/"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_앱_페이지는_그대로(self):
        for url in ("/", "/simulator/", "/nca/"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)
