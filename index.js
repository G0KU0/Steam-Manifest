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
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- MANIFEST ÉS FIX FORRÁSOK (A GitHub api.json és fixes.py alapján) ---
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
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

// --- SEGÉDFÜGGVÉNYEK ---

async function checkFixes(appid) {
    const results = { generic: null, online: null };
    try {
        const genRes = await axios.head(`${FIX_BASE_URLS.generic}${appid}.zip`).catch(() => null);
        if (genRes && genRes.status === 200) results.generic = `${FIX_BASE_URLS.generic}${appid}.zip`;

        const onlineRes = await axios.head(`${FIX_BASE_URLS.online}${appid}.zip`).catch(() => null);
        if (onlineRes && onlineRes.status === 200) results.online = `${FIX_BASE_URLS.online}${appid}.zip`;
    } catch (e) {}
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

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('SteamTools .lua generáló és Manifest kereső')
            .addSubcommand(sub => 
                sub.setName('id')
                    .setDescription('Generálás AppID alapján')
                    .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
                    .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k feloldása?')))
            .addSubcommand(sub => 
                sub.setName('nev')
                    .setDescription('Keresés név alapján')
                    .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                    .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k feloldása?'))),
        new SlashCommandBuilder()
            .setName('manage')
            .setDescription('Bot kezelése (Admin)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => sub.setName('add').setDescription('Jog adása').addUserOption(o => o.setName('target').setRequired(true).setDescription('Felhasználó')))
            .addSubcommand(sub => sub.setName('remove').setDescription('Jog elvétele').addUserOption(o => o.setName('target').setRequired(true).setDescription('Felhasználó'))),
        new SlashCommandBuilder()
            .setName('fix')
            .setDescription('Online Fix ellenőrzése AppID alapján')
            .addStringOption(o => o.setName('appid').setDescription('Játék AppID-ja').setRequired(true))
    ].map(c => c.toJSON());

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ ${client.user.tag} online, parancsok frissítve!`);
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    // Autocomplete kezelése
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        return interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, user, member } = interaction;
    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID] });

    // JOGOSULTSÁG ELLENŐRZÉS
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || user.id === process.env.ADMIN_ID;
    if (!isAdmin && !db.allowedUsers.includes(user.id)) {
        return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });
    }

    // MANIFEST & LUA GENERÁLÁS
    if (commandName === 'manifest') {
        const appId = options.getSubcommand() === 'id' ? options.getString('appid') : options.getString('jateknev');
        const includeDlc = options.getBoolean('dlc') ?? true;

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId].success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const dlcs = gameData.dlc || [];
            
            // LUA Generálás (Eredeti formátumod megtartva)
            let lua = `-- Generated by SteamTools Master\n-- Game: ${gameData.name}\n\nadd_app(${appId}, "${gameData.name}")\n`;
            if (includeDlc) dlcs.forEach(id => lua += `add_dlc(${id})\n`);

            const zip = await fetchManifestZip(appId);
            const fixes = await checkFixes(appId);

            const embed = new EmbedBuilder()
                .setTitle(`📦 SteamTools Master: ${gameData.name}`)
                .setColor(0x00FF00)
                .setThumbnail(gameData.header_image)
                .setDescription(`✅ **.lua fájl generálva**\n${zip ? `✅ **Manifest ZIP megtalálva:** [${zip.source}]` : '⚠️ Manifest ZIP nem található.'}`)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'DLC-k száma', value: dlcs.length.toString(), inline: true },
                    { name: 'Online Fix', value: fixes.online ? `✅ [Letöltés](${fixes.online})` : '❌ Nem található', inline: true },
                    { name: 'Generic Fix', value: fixes.generic ? `✅ [Letöltés](${fixes.generic})` : '❌ Nem található', inline: true }
                )
                .setFooter({ text: 'A .lua fájlt húzd a SteamTools ikonjára!' });

            const files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
            if (zip) files.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));

            await interaction.editReply({ embeds: [embed], files: files });

        } catch (e) {
            await interaction.editReply("❌ Hiba történt a generálás során.");
        }
    }

    // ADMIN KEZELÉS
    if (commandName === 'manage') {
        const sub = options.getSubcommand();
        const target = options.getUser('target');
        if (sub === 'add') { if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id); }
        else { db.allowedUsers = db.allowedUsers.filter(id => id !== target.id); }
        await db.save();
        return interaction.reply({ content: `✅ Felhasználó frissítve: ${target.tag}`, ephemeral: true });
    }

    // FIX KERESÉS
    if (commandName === 'fix') {
        const appId = options.getString('appid');
        await interaction.deferReply({ ephemeral: true });
        const fixes = await checkFixes(appId);
        const embed = new EmbedBuilder()
            .setTitle(`🛠️ Online Fix Ellenőrzés: ${appId}`)
            .setColor(0x3498db)
            .addFields(
                { name: 'Online Fix', value: fixes.online ? `✅ [Letöltés](${fixes.online})` : '❌ Nem található', inline: true },
                { name: 'Generic Fix', value: fixes.generic ? `✅ [Letöltés](${fixes.generic})` : '❌ Nem található', inline: true }
            );
        await interaction.editReply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
