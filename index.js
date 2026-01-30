require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- SLASH PARANCS DEFINÍCIÓ ---
const command = new SlashCommandBuilder()
    .setName('manifest')
    .setDescription('Steam manifest letöltése')
    .addSubcommand(sub => 
        sub.setName('id')
            .setDescription('Letöltés pontos AppID alapján')
            .addStringOption(opt => opt.setName('appid').setDescription('A játék ID-ja').setRequired(true)))
    .addSubcommand(sub => 
        sub.setName('nev')
            .setDescription('Keresés és letöltés név alapján')
            .addStringOption(opt => opt.setName('jateknev').setDescription('Kezdd el írni a játék nevét...').setRequired(true).setAutocomplete(true)));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- PARANCSOK REGISZTRÁLÁSA ---
client.once('ready', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: [command.toJSON()] });
    } catch (e) { console.error(e); }
});

// --- AUTOMATIKUS KIEGÉSZÍTÉS (AUTOCOMPLETE) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'manifest') {
        const focusedValue = interaction.options.getFocused();
        if (focusedValue.length < 2) return interaction.respond([]); // Csak 2 betű után keressen

        try {
            // Steam kereső API használata a nevekhez
            const search = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`);
            const suggestions = search.data.items
                .map(game => ({ name: `${game.name} (ID: ${game.id})`, value: game.id.toString() }))
                .slice(0, 10); // Discord limit: max 25 találat

            await interaction.respond(suggestions);
        } catch (e) {
            await interaction.respond([]);
        }
    }
});

// --- PARANCS VÉGREHAJTÁSA ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const subcommand = interaction.options.getSubcommand();
    let appId;

    if (subcommand === 'id') {
        appId = interaction.options.getString('appid').trim();
    } else {
        appId = interaction.options.getString('jateknev');
    }

    if (!/^\d+$/.test(appId)) {
        return interaction.reply({ content: '❌ Hiba: Érvénytelen AppID!', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        // Eredeti forrás szerinti URL-ek
        const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
        const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

        // Ellenőrzés
        await axios.get(checkUrl);

        // Letöltés
        const response = await axios({ method: 'get', url: downloadUrl, responseType: 'arraybuffer' });
        const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });

        const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('STEAM MANIFEST HUB')
            .setDescription(`A(z) **${appId}** manifestje sikeresen letöltve.`)
            .addFields(
                { name: 'DISCLAIMER', value: 'Ez a szoftver csak tájékoztató jellegű. Nem vállalunk felelősséget az adatok használatából eredő következményekért.' },
                { name: 'Forrás', value: 'Manifest Database' }
            )
            .setFooter({ text: 'by Szaby | © 2026' });

        await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (error) {
        await interaction.editReply(`❌ Nem található manifest a(z) **${appId}** AppID-hoz a Manifest Database-ben.`);
    }
});

client.login(process.env.DISCORD_TOKEN);
