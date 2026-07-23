// Discord LOGIN + DISCOVERY smoke. Verifies the bot token works, that the
// privileged intents the app uses (incl. Message Content) are enabled, and
// lists the guilds + text channels the bot can see so we can pick a parent
// channel. Reads DISCORD_BOT_TOKEN from the environment — never hard-code it.
import { Client, GatewayIntentBits, ChannelType, Events } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("Set DISCORD_BOT_TOKEN in the environment first.");
  process.exit(1);
}

// Same intents the app requests — proves the privileged Message Content intent
// is enabled in the Developer Portal (login fails with a clear error if not).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PERMS = "377957215232"; // view/send/manage msgs, embed, history, threads

client.once(Events.ClientReady, async (c) => {
  console.log(`OK  logged in as ${c.user.tag} (user id ${c.user.id})`);
  console.log(`    application id ${c.application?.id}`);
  console.log(
    `    invite: https://discord.com/api/oauth2/authorize?client_id=${c.user.id}` +
      `&scope=bot%20applications.commands&permissions=${PERMS}`
  );
  try {
    const guilds = await c.guilds.fetch();
    console.log(`    in ${guilds.size} guild(s):`);
    for (const [gid] of guilds) {
      const guild = await c.guilds.fetch(gid);
      console.log(`    • guild ${gid}  "${guild.name}"`);
      const channels = await guild.channels.fetch();
      for (const [cid, ch] of channels) {
        if (ch && ch.type === ChannelType.GuildText) {
          console.log(`        #${ch.name}  (channel id ${cid})`);
        }
      }
    }
    if (guilds.size === 0) {
      console.log("    (bot is in no guilds — invite it with the URL above, then re-run)");
    }
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.on(Events.Error, (e) => console.error("client error:", e?.message ?? e));
client.login(token).catch((e) => {
  console.error("LOGIN FAILED:", e?.message ?? e);
  if (String(e?.message ?? e).includes("disallowed intents")) {
    console.error(
      "→ Enable the 'Message Content Intent' (and Server Members if needed) under " +
        "Developer Portal → your app → Bot → Privileged Gateway Intents."
    );
  }
  process.exit(1);
});
