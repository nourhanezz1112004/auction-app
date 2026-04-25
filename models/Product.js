const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  image: String,
  category: String,
  highestBid: { type: Number, default: 0 },
  highestUser: { type: String, default: "" }
});

module.exports = mongoose.model("Product", productSchema);