"""
X 自動投稿の投稿先アカウントを変える: 今の開発者アプリ(コンシューマーキー)のまま、
別のアカウントのアクセストークンを PIN 方式で発行する。課金(クレジット)は今のアプリのまま。

使い方:
  py -3.12 -m pip install requests requests-oauthlib
  py -3.12 x_auth.py
  → コンシューマーキーとシークレットを入力
  → 表示された URL をブラウザで開き、「投稿したいアカウント」でログインして連携を許可
  → 表示された PIN(7桁の数字)を入力
  → 新しい Access Token / Access Token Secret が表示される
"""
from requests_oauthlib import OAuth1Session

key = input("コンシューマーキー(API Key): ").strip()
secret = input("コンシューマーキーのシークレット(API Key Secret): ").strip()

oauth = OAuth1Session(key, client_secret=secret, callback_uri="oob")
oauth.fetch_request_token("https://api.x.com/oauth/request_token")
url = oauth.authorization_url("https://api.x.com/oauth/authorize")
print("\n次の URL をブラウザで開き、投稿先にしたいアカウントでログインして「連携アプリを認証」を押してください:\n")
print(url, "\n")
pin = input("表示された PIN: ").strip()

oauth = OAuth1Session(key, client_secret=secret, resource_owner_key=oauth.token["oauth_token"],
                      resource_owner_secret=oauth.token["oauth_token_secret"], verifier=pin)
tok = oauth.fetch_access_token("https://api.x.com/oauth/access_token")
print("\n=== GitHub の Secrets に登録する値 ===")
print("アカウント      :", "@" + tok.get("screen_name", "?"))
print("X_ACCESS_TOKEN  :", tok["oauth_token"])
print("X_ACCESS_SECRET :", tok["oauth_token_secret"])
