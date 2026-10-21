require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
} = require("discord.js");

const pingCommand = require("./commands/ping");
const expenseCommand = require("./commands/expense");
const { startReminderScheduler } = require("./scheduler/reminder");

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// Command yang akan didaftarkan ke Discord
const commands = [
    pingCommand.data.toJSON(),
    expenseCommand.data.toJSON(),
];

async function registerCommands() {
    const rest = new REST({ version: "10" })
        .setToken(process.env.DISCORD_TOKEN);

    await rest.put(
        Routes.applicationGuildCommands(
            process.env.CLIENT_ID,
            process.env.GUILD_ID
        ),
        { body: commands }
    );

    console.log("✅ Slash commands berhasil didaftarkan");
}

client.once("clientReady", () => {
    console.log(`✅ ZEINZY Bot ONLINE sebagai ${client.user.tag}`);
    startReminderScheduler(client);
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === "ping") {
            await pingCommand.execute(interaction);
        }

        if (interaction.commandName === "expense") {
            await expenseCommand.execute(interaction);
        }
    } catch (error) {
        console.error("❌ Command error:", error);
    }
});

(async () => {
    try {
        await registerCommands();
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error("❌ Bot startup error:", error);
    }
})();