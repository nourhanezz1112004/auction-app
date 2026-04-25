from flask import Flask, request, jsonify
from sklearn.ensemble import RandomForestClassifier
import numpy as np

app = Flask(__name__)

# Dummy training
X = np.array([
    [1, 100],
    [5, 500],
    [10, 1000]
])

y = [0, 1, 1]  # 0 normal / 1 fraud

model = RandomForestClassifier()
model.fit(X, y)

@app.route("/detect-fraud", methods=["POST"])
def detect():
    data = request.json["bids"]

    feature = [[len(data), sum(b["amount"] for b in data)]]

    prediction = model.predict(feature)[0]

    return jsonify({
        "fraud": bool(prediction),
        "confidence": 0.9
    })

app.run(port=8002)