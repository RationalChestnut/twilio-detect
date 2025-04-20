import WebSocket from "ws";
import dotenv from "dotenv";
import Fastify from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyWebsocket from "@fastify/websocket";
import Twilio from "twilio";
import cors from "@fastify/cors";

dotenv.config();

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TARGET_PHONE_NUMBER,
  AUTO_CALL = "true",
} = process.env;
const SHOULD_AUTO_CALL = AUTO_CALL.toLowerCase() === "true";

const SHOW_TIMING_MATH = false;
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

if (!OPENAI_API_KEY) {
  console.error("Please set your OpenAI API key in the .env file");
  process.exit(1);
}

if (SHOULD_AUTO_CALL) {
  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_FROM_NUMBER ||
    !TARGET_PHONE_NUMBER
  ) {
    console.error(
      "To auto-initiate the call, please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, and TARGET_PHONE_NUMBER in .env"
    );
    process.exit(1);
  }
}

const fastify = Fastify();

// allow your React app on localhost:3000 to talk to this API
fastify.register(cors, {
  origin: ["http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

// now register formbody, websocket, etc.
fastify.register(fastifyFormbody);
fastify.register(fastifyWebsocket);

let SYSTEM_MESSAGE =
  "You are a helpful assistant. You have access to the following information: A car crash has just occurred. It is in Minnesota. There looks to be no fatalities, but one person looks seriously injured. One of the cars is on fire.";
const VOICE = "alloy";
const PORT = process.env.PORT || 5053;

// Initialize Twilio client if needed
let twilioClient;
if (SHOULD_AUTO_CALL) {
  twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Function to make the outgoing call
async function makeInitialCall() {
  try {
    const WEBHOOK_URL = process.env.CALLBACK_URL;
    const call = await twilioClient.calls.create({
      url: WEBHOOK_URL,
      to: TARGET_PHONE_NUMBER,
      from: TWILIO_FROM_NUMBER,
    });
    console.log(`Initiated call with SID: ${call.sid}`);
  } catch (err) {
    console.error("Failed to initiate call:", err);
  }
}

fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio web stream server is running" });
});

fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Say>Hello! I'm calling to report an emergency.</Say>
        <Pause length="1"/>
        <Say>Please ask any question about this emergency, I'll be happy to assist.</Say>
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on("open", () => {
      console.log("OpenAI WebSocket connection opened");
      setTimeout(initializeSession, 1000);
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        // Relay audio deltas back to Twilio
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) lastAssistantItem = response.item_id;

          // Mark stream for truncation control
          if (streamSid) {
            connection.send(
              JSON.stringify({
                event: "mark",
                streamSid,
                mark: { name: "responsePart" },
              })
            );
            markQueue.push("responsePart");
          }
        }

        // Truncate audio when user starts speaking
        if (response.type === "input_audio_buffer.speech_started") {
          if (markQueue.length && responseStartTimestampTwilio != null) {
            const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;
            if (SHOW_TIMING_MATH) console.log(`Elapsed: ${elapsed}ms`);

            if (lastAssistantItem) {
              openAiWs.send(
                JSON.stringify({
                  type: "conversation.item.truncate",
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms: elapsed,
                })
              );
            }

            connection.send(JSON.stringify({ event: "clear", streamSid }));

            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
          }
        }
      } catch (err) {
        console.error("Error processing OpenAI message:", err);
      }
    });

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            console.log("Stream started", streamSid);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case "media":
            latestMediaTimestamp = msg.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: msg.media.payload,
                })
              );
            }
            break;
          case "mark":
            if (markQueue.length) markQueue.shift();
            break;
          default:
            console.log("Non-media event:", msg.event);
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.post("/trigger-call", async (request, reply) => {
  console.log("Should trigger call");
  if (!twilioClient) {
    return reply
      .code(400)
      .send({ error: "Auto-call is disabled (AUTO_CALL=false)" });
  }

  const { prompt, to } = request.body;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return reply.code(400).send({ error: "Missing or invalid `prompt`" });
  }
  SYSTEM_MESSAGE = prompt;
  const toNumber = to || TARGET_PHONE_NUMBER;
  if (!toNumber) {
    return reply
      .code(400)
      .send({ error: "No destination number provided or configured" });
  }
  try {
    const WEBHOOK_URL = process.env.CALLBACK_URL;
    const call = await twilioClient.calls.create({
      url: WEBHOOK_URL,
      to: TARGET_PHONE_NUMBER,
      from: TWILIO_FROM_NUMBER,
    });
    console.log(`Initiated call with SID: ${call.sid}`);
  } catch (err) {
    console.error("Failed to initiate call:", err);
  }
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
