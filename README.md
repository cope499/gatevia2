# Gatevia（最小版）

指定したICで乗り降りするルート候補を、全て計算して選べるナビの最小版です。

- 地図 + 検索 + 指定IC候補 + ルート表示のみ（案内機能は含みません）
- ルーティング: 稼働中の指定IC強制ルーティングサービス
  `POST https://sedate-landmark-shrunk.ngrok-free.dev/route_candidates`（v9）
- 地図: Leaflet（同梱）+ OpenStreetMap、地名検索: Nominatim
- マイルート / 設定タブは準備中のプレースホルダです

静的ファイルのみで構成されています。このフォルダの中身を
`gatevia/` としてそのまま配信してください。
