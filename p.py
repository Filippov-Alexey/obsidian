import pymysql
# import json
# import os
# import re
# from flask import Flask, jsonify, request, send_from_directory, render_template

# # ---------------------------------------------------------------- config
# BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# with open(os.path.join(BASE_DIR, "config.json"), "r", encoding="utf-8") as f:
#     CONFIG = json.load(f)

# app = Flask(
#     __name__,
#     static_folder=os.path.join(BASE_DIR, "static"),
#     template_folder=os.path.join(BASE_DIR, "templates"),
# )

# ---------------------------------------------------------------- DB
def get_conn():
    try:
        conn = pymysql.connect(
            user='root',
            password='2010_GnitooR-2010',
            database='secondbrain',
            unix_socket='/run/mysqld/mysqld10.sock',
            cursorclass=pymysql.cursors.DictCursor
        )
        with conn.cursor() as cursor:
            cursor.execute("SELECT DATABASE();")
            print(f"Текущая база данных: {cursor.fetchone()}")

        # return conn  # Просто возвращаем открытое соединение
    except Exception as e:
        print(f"Ошибка при создании соединения: {e}")
        return None  # Если была ошибка, возвращаем None (блок finally убран)
get_conn()
