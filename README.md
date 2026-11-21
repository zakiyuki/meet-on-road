# 合流ナビ

別々の高速を走る車同士で現在地を共有し、お互い近い SA・PA・道の駅・コンビニを合流地点として提案するWebアプリ（サーバー不要）。

- 位置共有: 公開MQTTブローカー（broker.emqx.io）経由。中身はルームコードから作った鍵で AES-GCM 暗号化
- 地図: Leaflet + OpenStreetMap
- 候補検索: Overpass API ／ 所要時間: OSRM デモサーバー
- 共有はページを開いている間だけ
