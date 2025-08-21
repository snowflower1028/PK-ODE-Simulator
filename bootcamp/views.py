import os
import pandas as pd
import numpy as np
import hashlib
import json
from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from firebase_admin import firestore
import traceback

def welcome(request):
    """Welcome 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/welcome.html')

def morning_session(request):
    """오전 세션 페이지를 렌더링합니다."""
    return render(request, 'bootcamp/morning_session.html')

def qna_view(request):
    context = {
        'FIREBASE_API_KEY': os.environ.get('FIREBASE_API_KEY'),
        'FIREBASE_AUTH_DOMAIN': os.environ.get('FIREBASE_AUTH_DOMAIN'),
        'FIREBASE_PROJECT_ID': os.environ.get('FIREBASE_PROJECT_ID'),
        'FIREBASE_STORAGE_BUCKET': os.environ.get('FIREBASE_STORAGE_BUCKET'),
        'FIREBASE_MESSAGING_SENDER_ID': os.environ.get('FIREBASE_MESSAGING_SENDER_ID'),
        'FIREBASE_APP_ID': os.environ.get('FIREBASE_APP_ID'),
    }
    return render(request, 'bootcamp/qna.html', context)

def qna_api(request):
    db = firestore.client()

    # 질문 생성 (POST)
    if request.method == 'POST':
        data = json.loads(request.body)
        name = data.get('name')
        question = data.get('question')
        pin = data.get('pin')

        if not all([name, question, pin]):
            return JsonResponse({'status': 'error', 'message': '모든 필드를 입력해야 합니다.'}, status=400)

        # 서버에서 비밀번호 해싱
        pin_hash = hashlib.sha256(pin.encode('utf-8')).hexdigest()

        doc_ref = db.collection('questions').add({
            'name': name,
            'question': question,
            'pinHash': pin_hash,
            'timestamp': firestore.SERVER_TIMESTAMP
        })
        return JsonResponse({'status': 'ok', 'id': doc_ref[1].id})

    # 질문 삭제 (DELETE)
    if request.method == 'DELETE':
        data = json.loads(request.body)
        doc_id = data.get('id')
        pin = data.get('pin')

        if not all([doc_id, pin]):
            return JsonResponse({'status': 'error', 'message': 'ID와 비밀번호가 필요합니다.'}, status=400)

        doc_ref = db.collection('questions').document(doc_id)
        doc = doc_ref.get()

        if not doc.exists:
            return JsonResponse({'status': 'error', 'message': '질문을 찾을 수 없습니다.'}, status=404)

        stored_hash = doc.to_dict().get('pinHash')
        entered_hash = hashlib.sha256(pin.encode('utf-8')).hexdigest()

        if stored_hash == entered_hash:
            doc_ref.delete()
            return JsonResponse({'status': 'ok', 'message': '삭제되었습니다.'})
        else:
            return JsonResponse({'status': 'error', 'message': '비밀번호가 일치하지 않습니다.'}, status=403)

    return JsonResponse({'status': 'error', 'message': '잘못된 요청 메소드입니다.'}, status=405)
