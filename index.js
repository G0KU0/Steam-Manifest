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
// Az engedélyezett felhasználók és csatornák tárolásához
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String],
    logChannel: String
}));

// --- MANIFEST ÉS FIX FORRÁSOK (ltsteamplugin alapján) ---
// A források az api.json és fixes.py alapján lettek frissítve
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

// --- SEGÉDFÜGGVÉNYEK ---

async function checkFixes(appid) {
    const results = { generic: null, online: null };
    try {
        const genRes = await axios.head(`${FIX_BASE_URLS.generic}${appid}.zip`).catch(() => null);
        if (genRes && genRes.status === 200) results.generic = `${FIX_BASE_URLS.generic}${appid}.zip`;

        const onlineRes = await axios.head(`${FIX_BASE_URLS.online}${appid}.zip`).catch(() => null);
        if (onlineRes && onlineRes.status === 200) results.online = `${FIX_BASE_URLS.online}${appid}.zip`;
    } catch (e) { console.error("Hiba a fixek ellenőrzésekor:", e.message); }
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

async function sendLog(title, message) {
    const settings = await Settings.findOne();
    if (settings?.logChannel) {
        const channel = await client.channels.fetch(settings.logChannel).catch(() => null);
        if (channel) {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(message)
                .setTimestamp()
                .setColor(0x3498db);
            await channel.send({ embeds: [embed] });
        }
    }
}

// --- ESEMÉNYKEZELÉS ---

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, user, channelId, member } = interaction;

    // --- JOGOSULTSÁG ELLENŐRZÉS ---
    const settings = await Settings.findOne();
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const isAllowedUser = settings?.allowedUsers?.includes(user.id);
    const isAllowedChannel = settings?.allowedChannels?.includes(channelId);

    // Ha nem admin, és nincs a listán, megtagadjuk a hozzáférést
    if (!isAdmin && !isAllowedUser && !isAllowedChannel) {
        return interaction.reply({ 
            content: "❌ Nincs jogosultságod a bot használatához!", 
            ephemeral: true 
        });
    }

    // --- MANIFEST PARANCS ---
    if (commandName === 'manifest') {
        await interaction.deferReply({ ephemeral: true }); // Csak a felhasználó látja
        
        const appId = options.getString('appid');
        const includeDlc = options.getBoolean('dlc') ?? true;

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId].success) return interaction.editReply("❌ Érvénytelen AppID.");

            const gameData = steamRes.data[appId].data;
            const dlcs = gameData.dlc || [];

            // LUA generálás
            let lua = `-- SteamTools Unlocker Script\n-- Játék: ${gameData.name}\n\nadd_app(${appId})\n`;
            if (includeDlc) dlcs.forEach(id => lua += `add_app(${id})\n`);

            const manifestZip = await fetchManifestZip(appId);
            const fixes = await checkFixes(appId);

            const embed = new EmbedBuilder()
                .setTitle(`📦 SteamTools: ${gameData.name}`)
                .setColor(0x2ecc71)
                .setDescription(`✅ **LUA generálva**\n${manifestZip ? `✅ **Manifest ZIP megtalálva:** [${manifestZip.source}]` : '⚠️ Manifest ZIP nem található.'}`)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'DLC-k', value: dlcs.length.toString(), inline: true },
                    { name: 'Fixek', value: `${fixes.generic ? '[Generic](' + fixes.generic + ')' : '❌'} / ${fixes.online ? '[Online](' + fixes.online + ')' : '❌'}` }
                );

            const files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
            if (manifestZip) files.push(new AttachmentBuilder(Buffer.from(manifestZip.data), { name: `manifest_${appId}.zip` }));

            await interaction.editReply({ embeds: [embed], files: files });
            await sendLog('📥 Generálás', `**User:** ${user.tag}\n**Játék:** ${gameData.name}`);

        } catch (error) {
            await interaction.editReply("❌ Hiba történt az adatok lekérésekor.");
        }
    }

    // --- FIX PARANCS ---
    if (commandName === 'fix') {
        await interaction.deferReply({ ephemeral: true });
        const appId = options.getString('appid');
        const fixes = await checkFixes(appId);

        const embed = new EmbedBuilder()
            .setTitle(`🛠️ Javítások - AppID: ${appId}`)
            .setColor(fixes.generic || fixes.online ? 0x3498db : 0xe74c3c)
            .addFields(
                { name: 'Generic Fix', value: fixes.generic ? `[Letöltés](${fixes.generic})` : '❌ Nem található', inline: true },
                { name: 'Online Fix', value: fixes.online ? `[Letöltés](${fixes.online})` : '❌ Nem található', inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    }

    // --- ADMIN PARANCSOK (Engedélyek kezelése) ---
    if (commandName === 'admin') {
        if (!isAdmin) return interaction.reply({ content: "❌ Csak adminisztrátorok használhatják!", ephemeral: true });

        const sub = options.getSubcommand();
        let update = {};

        if (sub === 'user') {
            const target = options.getUser('target');
            const action = options.getString('action');
            if (action === 'add') update = { $addToSet: { allowedUsers: target.id } };
            else update = { $pull: { allowedUsers: target.id } };
            await Settings.findOneAndUpdate({}, update, { upsert: true });
            await interaction.reply({ content: `✅ Felhasználó frissítve: ${target.tag}`, ephemeral: true });
        }
        
        if (sub === 'channel') {
            const action = options.getString('action');
            if (action === 'add') update = { $addToSet: { allowedChannels: channelId } };
            else update = { $pull: { allowedChannels: channelId } };
            await Settings.findOneAndUpdate({}, update, { upsert: true });
            await interaction.reply({ content: `✅ Csatorna jogosultság frissítve.`, ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
