"""
WSGI config for pk_simulator project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/
"""

import os
import newrelic.agent
newrelic.agent.initialize('newrelic.ini')
newrelic.agent.register_application()

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'pk_simulator.settings')

application = get_wsgi_application()
