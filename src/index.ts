import { jsonc } from 'jsonc';
// import * as SwitchChat from 'switchchat';
import { TransactionRequest, parseCommonMeta, publishTransaction, refundTransaction } from './krist.js';
import { KristTransaction, calculateAddress, KristApi } from 'krist';
import nats, { AckPolicy, DeliverPolicy, JetStreamClient, ReplayPolicy } from 'nats';
import { createOrUpdateConsumer, createOrUpdateStream } from './jsmExtensions.js';

const nc = nats.connect({
    servers: process.env.NATS_SERVER ?? "127.0.0.1",
    user: process.env.NATS_USER ?? "krist",
    pass: process.env.NATS_PASSWORD ?? "krist",
});

const kristApi = new KristApi();

const { license, kristpkey, hostname, denylist } = jsonc.readSync(process.env.SOAK_CONFIG ?? "./config.jsonc");

// function getSwitchClient(): Promise<SwitchChat.Client> {
//     const switchClient = new SwitchChat.Client(license);
//     switchClient.connect(() => console.log("Connected to Switchcraft successfully."));
//     return new Promise((resolve) => {
//         switchClient.on("players", () => resolve(switchClient));
//     });
// }

// Setup all the listeners
const denyset = new Set(denylist);

async function processKristTX(tx: KristTransaction, js: JetStreamClient) {
    console.log("Received transaction: ", tx);

    return await refundTransaction(js, tx, { error: "SwitchCraft is now closed, thank you for playing." });

    // const metadata = parseCommonMeta(tx.metadata);

    // const switchClient = await getSwitchClient();
    // const players = Array.from(switchClient.players)
    //     .filter(player => player.name !== metadata.username && !denyset.has(player.uuid))
    //     .filter(player => player.afk === false);

    // console.log("Found eligible players: ", players.map(player => player.name));

    // switchClient.close(); // Make sure we don't keep the connection open

    // if (players.length === 0) return await refundTransaction(js, tx, { error: "No eligible players could be found. Is the server offline?" });

    // const message = metadata.message;

    // const split = Math.floor(tx.value / players.length);
    // const leftover = tx.value % players.length;
    // console.log(`Split: ${split}, leftover: ${leftover}`);
    // if (split === 0) return await refundTransaction(js, tx, { error: `Not enough KST for all players online. Must be at least ${players.length}KST.` });
    // if (message && split < 10) return await refundTransaction(js, tx, { error: `Per-player split must be at least 10KST to include a message. Your split was ${split}KST.` });
    // if (leftover > 0) await refundTransaction(js, tx, { message: "Amount could not be split evenly between players, here is the leftover." }, leftover);

    // await Promise.all(players.map(player => 
    //     publishTransaction(js, tx, {
    //         to: `${player.name}@switchcraft.kst`,
    //         amount: split,
    //         meta: {
    //             message: [
    //                 `${metadata.username || tx.from} donated ${split}kst to you through ${hostname}!`,
    //                 message && `They left a message: ${message}`,
    //             ].filter(Boolean).join(" ")
    //         }
    //     })
    // ));
}

function calculateDelay(retryCount: number, initialDelay = 1000, jitter = 500, exponentialFactor = 1.5) {
    return initialDelay * Math.pow(exponentialFactor, Math.min(retryCount, 5)) + Math.random() * jitter;
}

nc.catch(e => {
    console.error("Error connecting to NATS: ", e)
    process.exit(1);
}).then(async (nc) => {
    console.log("Connected to NATS successfully.");
    
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();

    const [address] = await calculateAddress(kristpkey, undefined, "api");

    // Create stream for sending txs
    await createOrUpdateStream(jsm, {
        name: "soak",
        subjects: ["soak.txs.outgoing"],
    });

    // Create durable consumer if it doesn't exist
    await createOrUpdateConsumer(jsm, "krist", {
        durable_name: "soak-krist",
        deliver_policy: DeliverPolicy.New,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: `krist.from.*.to.${address}`,
    });

    await createOrUpdateConsumer(jsm, "soak", {
        durable_name: "soak-sender",
        deliver_policy: DeliverPolicy.New,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: "soak.txs.outgoing",

        max_ack_pending: 8,
    });

    const kristConsumer = await js.consumers.get("krist", "soak-krist");
    const soakSenderConsumer = await js.consumers.get("soak", "soak-sender");

    await Promise.any([
        kristConsumer.consume().then(async messages => {
            for await (const msg of messages) {
                const tx = msg.json<KristTransaction>();
        
                if (tx.to !== address || tx.sent_name !== hostname) {
                    msg.ack();
                    continue;
                }

                try {
                    await processKristTX(tx, js);
                    msg.ack();
                } catch (e) {
                    console.error("Error in transaction handler:", e);
                    msg.nak(calculateDelay(msg.info.redeliveryCount));
                }
            }
        }),

        soakSenderConsumer.consume().then(async messages => {
            for await (const msg of messages) {
                const req = msg.json<TransactionRequest>();

                try {
                    console.log("Sending transaction request to Krist API:", req);
                    await kristApi.makeTransaction(req.to, req.amount, {
                        metadata: req.meta,
                        privatekey: kristpkey,
                    })
                    msg.ack();
                } catch (e) {
                    msg.info.redeliveryCount
                    console.error("Error in transaction request:", e);
                    msg.nak(calculateDelay(msg.info.redeliveryCount));
                }
            }
        })
    ])
});
