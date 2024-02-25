import { jsonc } from 'jsonc';
import * as SwitchChat from 'switchchat';
import Krist from './krist';

const { license, kristpkey, hostname, blacklist } = jsonc.readSync(process.env.SOAK_CONFIG ?? "./config.jsonc");

// const switchClient = new SwitchChat.Client(license);
// switchClient.connect(() => console.log("Connected to Switchcraft successfully."));

function getSwitchClient(): Promise<SwitchChat.Client> {
    const switchClient = new SwitchChat.Client(license);
    switchClient.connect(() => console.log("Connected to Switchcraft successfully."));
    return new Promise((resolve) => {
        switchClient.on("players", () => resolve(switchClient));
    });
}

const kristClient = new Krist.Client();

// Setup all the listeners
const blackset = new Set(blacklist);
kristClient.registerNameTXListener(hostname, async (tx: Krist.Transaction) => {
    const switchClient = await getSwitchClient();
    const players = Array.from(switchClient.players)
        .filter(player => player.name !== tx.metadata.username && !blackset.has(player.uuid))
        .filter(player => player.afk === false);

    switchClient.close(); // Make sure we don't keep the connection open

    if (players.length === 0) return await tx.refund({ error: "No eligible players could be found. Is the server offline?" });

    const message = tx.metadata.message;

    const split = Math.floor(tx.value / players.length);
    const leftover = tx.value % players.length;
    if (split === 0) return await tx.refund({ error: `Not enough KST for all players online. Must be at least ${players.length}KST.` });
    if (message && split < 10) return await tx.refund({ error: `Per-player split must be at least 10KST to include a message. Your split was ${split}KST.` });
    if (leftover > 0) await tx.refund({ message: "Amount could not be split evenly between players, here is the leftover." }, leftover);

    if (message) {
        await Promise.all(players.map(player => kristClient.makeTransaction(`${player.name}@switchcraft.kst`, split, 
            { message: `${tx.metadata.username || tx.from} donated ${split}kst to you through ${hostname}! They left a message: ${message}` })));
    } else {
        await Promise.all(players.map(player => kristClient.makeTransaction(`${player.name}@switchcraft.kst`, split, 
            { message: `${tx.metadata.username || tx.from} donated ${split}kst to you through ${hostname}!` })));
    }
});

// Setup randomly timed distribution events (between 1-2 days)
const randomTime = () => Math.floor(Math.random() * 86400000) + 86400000;
const distribute = async () => {
    const switchClient = await getSwitchClient();
    const players = Array.from(switchClient.players)
        .filter(player => !blackset.has(player.uuid))
        .filter(player => player.afk === false);

    switchClient.close(); // Make sure we don't keep the connection open

    if (players.length === 0) return setTimeout(distribute, randomTime());

    await kristClient.refetchAddress();

    const maxSplit = Math.min(50, Math.floor(kristClient.currAddress.balance / players.length));
    const split = Math.floor(Math.random() * maxSplit) + 1;
    if (split === 0) return setTimeout(distribute, randomTime())

    await Promise.all(players.map(player => kristClient.makeTransaction(`${player.name}@switchcraft.kst`, split,
        { message: `You have been randomly selected to receive ${split}kst from ${hostname}!` })));

    setTimeout(distribute, randomTime());
};




kristClient.connect(kristpkey)
    .then(() => {
        console.log("Connected to Krist successfully.");
        // setTimeout(distribute, randomTime());
        distribute();
    })
    .catch(e => {
        console.error("Error connecting to Krist: ", e);
        process.exit(11);
    });
