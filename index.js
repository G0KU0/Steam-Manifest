require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- SLASH PARANCS DEFINÍCIÓ ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése AppID alapján')
        .addStringOption(option => 
            option.setName('appid')
                .setDescription('A játék Steam AppID-ja (pl. 220968)')
                .setRequired(true))
].map(command => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- PARANCSOK REGISZTRÁLÁSA ---
client.once('ready', async () => {
    console.log(`Bot bejelentkezve: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Slash parancsok frissítése...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash parancsok sikeresen regisztrálva!');
    } catch (error) {
        console.error(error);
    }
});

// --- INTERAKCIÓ KEZELÉSE ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        const appId = interaction.options.getString('appid').trim();

        // Validáció: csak számokat fogadunk el
        if (!/^\d+$/.test(appId)) {
            return interaction.reply({ content: '❌ [ERROR] Kérlek, csak számokat adj meg AppID-ként!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

            // 1. Ellenőrzés a forrásfájlokban lévő API alapján
            await axios.get(checkUrl);

            // 2. ZIP fájl letöltése a forrásfájlban megadott URL-ről
            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'arraybuffer'
            });

            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });

            const embed = new EmbedBuilder()
                .setColor(0x3b82f6) // A weboldal kék színe
                .setTitle('STEAM MANIFEST HUB')
                .setDescription(`A(z) **${appId}** azonosítóhoz tartozó manifest fájlt letöltöttem.`)
                .addFields(
                    { name: 'DISCLAIMER', value: 'Ez a szoftver csak tájékoztató jellegű. Nem vállalunk felelősséget a használatból eredő következményekért.' }, //
                    { name: 'Forrás', value: 'ManifestHub Database' }
                )
                .setFooter({ text: 'Made By SSMG4 | © 2026' }); //

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            // Ha nem található a manifest
            await interaction.editReply({ 
                content: `> MANIFEST NOT FOUND\nNem található manifest a(z) **${appId}** AppID-hoz az adatbázisban.` 
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
