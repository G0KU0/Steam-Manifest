require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('SteamTools Master Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- MANIFEST ÉS FIX FORRÁSOK (ltsteamplugin alapján) ---
const MANIFEST_SOURCES = [
    { name: 'Morrenus (API)', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'TwentyTwo Cloud', url: (id) => `http://masss.pythonanywhere.com/storage?auth=IEOIJE54esfsipoE56GE4&appid=${id}` },
    { name: 'Sushi (GitHub)', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

const FIX_BASE_URLS = {
    generic: "https://files.luatools.work/GameBypasses/",
    online: "https://files.luatools.work/OnlineFix1/"
};

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// --- SLASH PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('SteamTools .lua generáló és Manifest kereső')
        .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
        .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k feloldása? (Alapértelmezett: True)')),
    
    new SlashCommandBuilder()
        .setName('fix')
        .setDescription('Elérhető javítások (Fixes) keresése az AppID-hoz')
        .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true)),

    // ... (többi parancs marad)
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function checkFixes(appid) {
    const results = { generic: null, online: null };
    try {
        const genRes = await axios.head(`${FIX_BASE_URLS.generic}${appid}.zip`).catch(() => null);
        if (genRes && genRes.status === 200) results.generic = `${FIX_BASE_URLS.generic}${appid}.zip`;

        const onlineRes = await axios.head(`${FIX_BASE_URLS.online}${appid}.zip`).catch(() => null);
        if (onlineRes && onlineRes.status === 200) results.online = `${FIX_BASE_URLS.online}${appid}.zip`;
    } catch (e) { console.error("Fix check error:", e); }
    return results;
}

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 5000 });
            if (res.status === 200) return { data: res.data, source: source.name };
        } catch (e) { continue; }
    }
    return null;
}

// --- ESEMÉNYKEZELÉS ---

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'manifest') {
        await interaction.deferReply();
        const appId = options.getString('appid');
        const includeDlc = options.getBoolean('dlc') ?? true;

        const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`).catch(() => null);
        if (!steamRes || !steamRes.data[appId].success) return interaction.editReply("❌ Játék nem található.");

        const gameData = steamRes.data[appId].data;
        const dlcs = gameData.dlc || [];

        // LUA Generálás (Kifinomultabb verzió)
        let lua = `-- SteamTools Unlocker Script\n-- Játék: ${gameData.name}\n-- Generálva: ${new Date().toLocaleString()}\n\nadd_app(${appId})\n`;
        if (includeDlc) {
            dlcs.forEach(id => lua += `add_app(${id})\n`);
        }

        const manifestZip = await fetchManifestZip(appId);
        const fixes = await checkFixes(appId);

        const embed = new EmbedBuilder()
            .setTitle(`📦 SteamTools: ${gameData.name}`)
            .setColor(0x00FF00)
            .setDescription(`✅ **LUA generálva**\n${manifestZip ? `✅ **Manifest ZIP megtalálva:** [${manifestZip.source}]` : '⚠️ Manifest nem található.'}`)
            .addFields(
                { name: 'AppID', value: appId, inline: true },
                { name: 'DLC-k száma', value: dlcs.length.toString(), inline: true },
                { name: 'Elérhető Fixek', value: `${fixes.generic ? '[Generic Fix](' + fixes.generic + ')' : 'Nincs'} / ${fixes.online ? '[Online Fix](' + fixes.online + ')' : 'Nincs'}` }
            )
            .setFooter({ text: `Használat: Húzd a .lua-t a SteamTools-ra!` });

        const files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
        if (manifestZip) files.push(new AttachmentBuilder(Buffer.from(manifestZip.data), { name: `manifest_${appId}.zip` }));

        await interaction.editReply({ embeds: [embed], files: files });
    }

    if (commandName === 'fix') {
        await interaction.deferReply();
        const appId = options.getString('appid');
        const fixes = await checkFixes(appId);

        const embed = new EmbedBuilder()
            .setTitle(`🛠️ Javítások (Fixes) - AppID: ${appId}`)
            .setColor(fixes.generic || fixes.online ? 0x3b82f6 : 0xff0000)
            .setDescription(fixes.generic || fixes.online 
                ? "Az alábbi javítások érhetőek el a játékhoz:" 
                : "Sajnos nem találtam automatikus javítást ehhez a játékhoz.")
            .addFields(
                { name: 'Generic Fix', value: fixes.generic ? `[Letöltés](${fixes.generic})` : '❌ Nem érhető el', inline: true },
                { name: 'Online Fix', value: fixes.online ? `[Letöltés](${fixes.online})` : '❌ Nem érhető el', inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
