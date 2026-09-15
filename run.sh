#!/bin/sh
# Установка (один раз) и запуск веб-интерфейса.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python -m streamlit run app.py
