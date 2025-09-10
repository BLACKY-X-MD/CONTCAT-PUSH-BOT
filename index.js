import {
    makeWASocket,
    Browsers,
    generateWAMessageFromContent,
    proto,
    fetchLatestBaileysVersion,
    DisconnectReason,
    useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import pino from 'pino';
import fs from 'fs';
import NodeCache from 'node-cache';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import config from './config.cjs';

const sessionName = "session";
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const msgRetryCounterCache = new NodeCache();
const otpStore = new NodeCache({ stdTTL: 300 });

const MAIN_LOGGER = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` });
const logger = MAIN_LOGGER.child({});
logger.level = "trace";

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

const sessionDir = path.join(__dirname, 'session');
const credsPath = path.join(sessionDir, 'creds.json');

if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

let useQR = true;
let initialConnection = true;

async function checkSessionData() {
    try {
        if (fs.existsSync(credsPath)) {
            console.log("🔒 Session data found in creds.json");
            useQR = false; // Skip QR if session data exists
            return true;
        } else {
            console.log("⚠️ No session data found. QR code will be displayed for authentication.");
            useQR = true;
            return false;
        }
    } catch (error) {
        console.error('Error checking session data:', error.message);
        return false;
    }
}

async function start() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`🤖 ALG-MD using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const Matrix = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: useQR,
            browser: ["ALG-MD", "safari", "3.3"],
            auth: state,
            msgRetryCounterCache,
            shouldIgnoreJid: (jid) => false,
        });

        global.Matrix = Matrix;

        Matrix.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            io.emit('connection-update', update);

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.redBright('💔 Connection closed. Reconnecting:', shouldReconnect));
                if (shouldReconnect) setTimeout(start, 5000);
            } else if (connection === 'open') {
                if (initialConnection) {
                    console.log(chalk.greenBright("🌟 OTP-MD-CONNECTED 🌟"));
                    io.emit('status', '🌟 OTP-MD-CONNECTED 🌟');
                    
                    
                    try {
                        await Matrix.sendMessage('94753262213@s.whatsapp.net', { 
                            text: '🌟 OTP-MD Bot Connected Successfully! 🌟' 
                        });
                        console.log('✅ Connection success message sent to 94753262213');
                    } catch (error) {
                        console.error('Failed to send connection success message:', error.message);
                    }
                    
                    initialConnection = false;
                } else {
                    console.log(chalk.blue("♻️ Connection reestablished."));
                    io.emit('status', '♻️ Connection reestablished.');
                }
            }
        });

        Matrix.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('Failed to start WhatsApp bot:', error.message);
        io.emit('status', '❌ Failed to start WhatsApp bot.');
    }
}

app.get('/send-otp', async (req, res) => {
    const { number } = req.query;

    if (!number) return res.status(400).json({ error: 'Phone number is required!' });

    if (!global.Matrix || !global.Matrix.user) {
        return res.status(500).json({ error: 'WhatsApp bot is not connected!' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(number, otp);

    try {
        const msg = generateWAMessageFromContent(
            `${number}@s.whatsapp.net`,
            {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2
                        },
                        interactiveMessage: proto.Message.InteractiveMessage.create({
                            body: proto.Message.InteractiveMessage.Body.create({
                                text: `Your OTP is *${otp}*. Please use it to verify your identity.\n\nVisit our site: https://solo-leveling-mini-x.vercel.app/`
                            }),
                            footer: proto.Message.InteractiveMessage.Footer.create({
                                text: "ᴅɪɴᴜ xᴅ ᴘʀᴏɢʀᴀᴍᴇʀ"
                            }),
                            header: proto.Message.InteractiveMessage.Header.create({
                                title: "OTP Verification",
                                subtitle: "> ᴅɪɴᴜ xᴅ",
                                hasMediaAttachment: false
                            }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: [
                                    {
                                        name: "cta_copy",
                                        buttonParamsJson: JSON.stringify({
                                            display_text: "Copy OTP",
                                            id: `copy_otp_${otp}`,
                                            copy_code: otp
                                        })
                                    },
                                    {
                                        name: "cta_url",
                                        buttonParamsJson: JSON.stringify({
                                            display_text: "Visit Site",
                                            url: "https://solo-leveling-mini-x.vercel.app/",
                                            merchant_url: "https://solo-leveling-mini-x.vercel.app/"
                                        })
                                    }
                                ]
                            })
                        })
                    }
                }
            },
            {}
        );
        await global.Matrix.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });

        console.log(`✅ OTP sent to ${number}`);

        res.status(200).json({
            message: `OTP sent successfully`,
            number: number,
            otp: otp,
            status: "success"
        });

    } catch (error) {
        console.error('Failed to send OTP:', error);
        return res.status(500).json({ error: 'Failed to send OTP', details: error.message });
    }
});

app.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;

    if (!number) return res.status(400).json({ error: 'Phone number is required!' });
    if (!otp) return res.status(400).json({ error: 'OTP is required!' });

    const storedOtp = otpStore.get(number);

    if (!storedOtp) {
        return res.status(400).json({ error: 'OTP not found. Please request OTP first.' });
    }

    if (storedOtp === otp) {
        otpStore.del(number);
        console.log(`✅ OTP verified successfully for ${number}`);
        return res.status(200).json({
            message: 'OTP verified successfully!',
            status: 'success'
        });
    } else {
        console.log(`❌ Invalid OTP for ${number}`);
        return res.status(400).json({
            error: 'Invalid OTP or OTP expired. Please try again.',
            status: 'failure'
        });
    }
});

app.get('/send-message', async (req, res) => {
    const { number, message } = req.query;

    if (!number) return res.status(400).json({ error: 'Phone number is required!' });
    if (!message) return res.status(400).json({ error: 'Message text is required!' });

    if (!global.Matrix || !global.Matrix.user) {
        return res.status(500).json({ error: 'WhatsApp bot is not connected!' });
    }

    try {
        await global.Matrix.sendMessage(`${number}@s.whatsapp.net`, { text: message });

        console.log(`✅ Message sent to ${number}: ${message}`);

        return res.status(200).json({
            message: `Message sent to ${number}`,
            text: message
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to send message' });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log('🌐 New client connected');
    socket.on('disconnect', () => {
        console.log('❌ Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(chalk.greenBright(`🚀 Server running on http://localhost:${PORT}`));
});

checkSessionData().then((sessionExists) => {
    start();
});
