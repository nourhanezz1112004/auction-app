const axios = require("axios");

async function checkFraud(bids) {
  try {

    const response = await axios.post(
      "http://127.0.0.1:8002/detect-bot",
      { bids }
    );

    return response.data;

  } catch (error) {

    console.error("❌ Error connecting to AI:", error.message);

    return {
      fraud: false,
      confidence: 0
    };
  }
}

module.exports = checkFraud;