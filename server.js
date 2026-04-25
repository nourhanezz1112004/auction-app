const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const WebSocket = require("ws");
const { createClient } = require("redis");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ================= MongoDB =================
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/auction")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log(err));

// ================= Models =================
const ProductSchema = new mongoose.Schema({
  name: String,
  price: Number,
  image: String,
  category: String,
  highestBid: { type: Number, default: 0 },
  highestUser: String,
  winnerToken: String,
  ended: { type: Boolean, default: false }
});

const Product = mongoose.models.Product || mongoose.model("Product", ProductSchema);

// ================= Firebase =================
let serviceAccount;

if (process.env.FIREBASE_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
  try {
    serviceAccount = require("./auction-app-cb943-firebase-adminsdk-fbsvc-04e0a8d901.json");
  } catch {
    console.log("⚠️ Firebase key not found");
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

async function sendNotification(token, title, body) {
  try {
    await admin.messaging().send({
      notification: { title, body },
      token
    });
    console.log("✅ Notification sent");
  } catch (err) {
    console.log("❌ Notification error", err.message);
  }
}

// ================= Redis =================
const redis = createClient({
  url: process.env.REDIS_URL || undefined
});

redis.connect()
  .then(() => console.log("✅ Redis connected"))
  .catch(err => console.error(err));

// ================= Memory =================
let auctionUsers = {};
let auctions = {};
let userBids = {};

// ================= APIs =================
app.get("/products", async (req, res) => {
  res.json(await Product.find());
});

app.post("/products", async (req, res) => {
  const product = await Product.create(req.body);
  res.json(product);
});

app.post("/bid/:id", async (req, res) => {
  const { amount, user, token } = req.body;

  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  if (amount > product.highestBid) {
    product.highestBid = amount;
    product.highestUser = user;
    product.winnerToken = token;
    await product.save();
  }

  res.json(product);
});

app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  const products = await Product.find({
    name: { $regex: q, $options: "i" }
  });
  res.json(products);
});

app.get("/trending", async (req, res) => {
  const products = await Product.find().sort({ highestBid: -1 }).limit(5);
  res.json(products);
});

app.post("/login", (req, res) => {
  const { email } = req.body;

  const token = jwt.sign(
    { email },
    process.env.JWT_SECRET || "SECRET_KEY",
    { expiresIn: "7d" }
  );

  res.json({ token });
});

app.post("/notify", (req, res) => {
  const { user, message } = req.body;
  console.log(`🔔 Notification to ${user}: ${message}`);
  res.json({ success: true });
});

// ================= AI =================
async function checkBot(bids) {
  try {
    const res = await axios.post(process.env.AI_BOT_URL || "http://localhost:8001/detect-bot", { bids });
    return res.data;
  } catch {
    return { is_bot: false, confidence: 0 };
  }
}

async function checkFraud(bids) {
  try {
    const res = await axios.post(process.env.AI_FRAUD_URL || "http://localhost:8002/detect-fraud", { bids });
    return res.data;
  } catch {
    return { fraud: false, confidence: 0 };
  }
}

// ================= Auction End =================
async function endAuction(productId) {
  const product = await Product.findById(productId);
  if (!product || !product.winnerToken) return;

  console.log("🏁 Auction ended");

  await sendNotification(
    product.winnerToken,
    "🎉 You Won!",
    `You won ${product.name} with ${product.highestBid}$`
  );
}

// ================= Auto End =================
setInterval(async () => {
  const products = await Product.find();

  for (const p of products) {
    if (p.highestBid >= 1000 && !p.ended) {
      p.ended = true;
      await p.save();
      await endAuction(p._id);
    }
  }
}, 10000);

// ================= Server =================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

// ================= WebSocket =================
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "JOIN_AUCTION") {
        const { auctionId } = data;
        ws.auctionId = auctionId;

        auctionUsers[auctionId] = (auctionUsers[auctionId] || 0) + 1;

        if (!auctions[auctionId]) {
          auctions[auctionId] = { highestBid: 0, highestUser: null };
        }

        ws.send(JSON.stringify({
          type: "AUCTION_STATE",
          data: auctions[auctionId]
        }));

        broadcast(auctionId, {
          type: "USERS_COUNT",
          count: auctionUsers[auctionId]
        });
      }

      if (data.type === "PLACE_BID") {
        const { auctionId, bid, user } = data;

        if (!auctions[auctionId]) return;

        userBids[user] = userBids[user] || [];
        userBids[user].push({
          amount: bid,
          time: Date.now(),
          seller: auctionId
        });

        const botCheck = await checkBot(userBids[user]);
        if (botCheck.is_bot && botCheck.confidence > 0.8) {
          return ws.send(JSON.stringify({ type: "BOT_DETECTED" }));
        }

        const fraudCheck = await checkFraud(userBids[user]);
        if (fraudCheck.fraud && fraudCheck.confidence > 0.8) {
          return ws.send(JSON.stringify({ type: "FRAUD_DETECTED" }));
        }

        if (bid > auctions[auctionId].highestBid) {
          auctions[auctionId].highestBid = bid;
          auctions[auctionId].highestUser = user;

          await redis.set(
            `auction:${auctionId}`,
            JSON.stringify(auctions[auctionId])
          );

          broadcast(auctionId, {
            type: "NEW_BID",
            bid,
            user
          });
        }
      }

    } catch (err) {
      console.log("WS Error:", err.message);
    }
  });

  ws.on("close", () => {
    if (ws.auctionId && auctionUsers[ws.auctionId]) {
      auctionUsers[ws.auctionId]--;

      broadcast(ws.auctionId, {
        type: "USERS_COUNT",
        count: auctionUsers[ws.auctionId]
      });
    }
  });
});
app.get("/recommend/:userId", async (req, res) => {
  const products = await Product.find().limit(5);
  res.json(products);
});
// ================= Broadcast =================
function broadcast(auctionId, data) {
  wss.clients.forEach(client => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.auctionId === auctionId
    ) {
      client.send(JSON.stringify(data));
    }
  });
}