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

// --- MANIFEST FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

// --- SLASH PARANCSOK REGISZTRÁLÁSA ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('SteamTools .lua generáló és Manifest kereső')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Generálás AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Szeretnéd az összes DLC-t is feloldani? (Alapértelmezett: True)')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Kezdd el gépelni a játék nevét').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Szeretnéd az összes DLC-t is feloldani? (Alapértelmezett: True)'))),
    
    new SlashCommandBuilder()
        .setName('fix')
        .setDescription('Gyakori SteamTools hibák és megoldások'),

    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Bot kezelése (Admin)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Jogosultság adása').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Jogosultság elvétele').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Engedélyezett felhasználók listája')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true))))
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 5000 });
            if (res.status === 200) return { data: res.data, source: source.name };
        } catch (e) { continue; }
    }
    return null;
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
    return chunks;
}

async function sendLog(title, description, color = 0x3b82f6) {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
}

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ ${client.user.tag} online és parancsok frissítve!`);
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        await interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // FIX PARANCS
    if (interaction.commandName === 'fix') {
        const fixEmbed = new EmbedBuilder()
            .setTitle('🛠️ SteamTools Segítség')
            .setColor(0xFFA500)
            .addFields(
                { name: '❌ Hibás gomb (PURCHASE)', value: 'Frissítsd a SteamToolst vagy töröld az `appcache/appinfo.vdf` fájlt.' },
                { name: '📁 Hogyan kell betölteni?', value: 'A letöltött `.lua` fájlt egyszerűen húzd rá a SteamTools lebegő ikonjára!' },
                { name: '🌐 DLC-k nem látszanak?', value: 'Használd a bot által generált `.lua` fájlt, az minden DLC-t hozzáad.' }
            );
        return interaction.reply({ embeds: [fixEmbed], ephemeral: true });
    }

    // ADMIN PARANCSOK
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Csak az admin használhatja!', ephemeral: true });
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('target') || interaction.options.getChannel('channel');

        if (group === 'user') {
            if (sub === 'add') { if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id); }
            else if (sub === 'remove') db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
            else if (sub === 'list') return interaction.reply({ content: `Tagok: ${db.allowedUsers.map(id => `<@${id}>`).join(', ')}`, ephemeral: true });
        } else if (group === 'channel') {
            if (sub === 'add') { if (!db.allowedChannels.includes(target.id)) db.allowedChannels.push(target.id); }
            else if (sub === 'remove') db.allowedChannels = db.allowedChannels.filter(id => id !== target.id);
        }
        await db.save();
        return interaction.reply({ content: '✅ Beállítások mentve!', ephemeral: true });
    }

    // MANIFEST & LUA GENERÁLÁS
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: '❌ Itt nem használhatod!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs jogod!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            if (!steamRes.data[appId].success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const dlcs = gameData.dlc || [];
            
            // LUA Generálás
            let lua = `-- SteamTools Unlocker Script\n-- Game: ${gameData.name}\n\nadd_app(${appId}, "${gameData.name}")\n`;
            if (includeDlc) dlcs.forEach(id => lua += `add_dlc(${id})\n`);

            let files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
            let statusLines = [`✅ **${gameData.name}** (.lua generálva)`];
            if (includeDlc) statusLines.push(`🔹 DLC-k feloldva a fájlban: ${dlcs.length} db`);

            // GitHub Manifest Keresés (Fallback)
            const zip = await fetchManifestZip(appId);
            if (zip) {
                files.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                statusLines.push(`✅ Manifest ZIP megtalálva: [${zip.source}]`);
            } else {
                statusLines.push(`⚠️ Kész manifest ZIP nem található (használd a .lua fájlt!)`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 SteamTools Master: ${gameData.name}`)
                .setColor(0x00FF00)
                .setDescription(statusLines.join('\n') + '\n\n**Hogyan használd?**\n1. A `.lua` fájlt húzd a SteamTools ikonjára.\n2. Ha kaptál `.zip`-et, azt csomagold ki a Steam mappádba.')
                .setFooter({ text: `AppID: ${appId}` });

            await interaction.editReply({ embeds: [embed], files: files });
            await sendLog('📥 Generálás', `**User:** ${interaction.user.tag}\n**Játék:** ${gameData.name}\n**DLC-k:** ${dlcs.length}`);

        } catch (e) {
            await interaction.editReply("❌ Hiba történt a generálás során.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
