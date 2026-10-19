const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Cek apakah ZEINZY Bot aktif"),

    async execute(interaction) {
        await interaction.reply("🏓 ZEINZY Bot aktif!");
    },
};