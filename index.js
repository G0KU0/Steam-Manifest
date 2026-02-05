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

// --- MANILUA LOGIKA (A BEKÜLDÖTT GO KÓD ALAPJÁN) ---
async function processFilesToLua(attachments, appId = "unknown") {
    let manifestFiles = {};
    let configData = {};

    for (const attachment of attachments.values()) {
        try {
            const response = await axios.get(attachment.url, { responseType: 'text' });
            const content = response.data;
            const fileName = attachment.name;

            if (fileName.endsWith('.manifest')) {
                const parts = fileName.split('_');
                if (parts.length >= 2) {
                    const depotID = parts[0];
                    const manifestNumber = parts[1].replace('.manifest', '');
                    manifestFiles[depotID] = manifestNumber;
                }
            } else if (fileName === 'config.vdf') {
                const depotRegex = /"(\d+)"\s*{\s*"DecryptionKey"\s*"([^"]+)"/g;
                let match;
                while ((match = depotRegex.exec(content)) !== null) {
                    configData[match[1]] = match[2];
                }
            }
        } catch (e) { console.error("Hiba a fájl feldolgozása közben:", e); }
    }

    let outputEntries = [];
    for (const depotID in manifestFiles) {
        if (configData[depotID]) {
            outputEntries.push(`addappid(${depotID}, 1, "${configData[depotID]}")\nsetManifestid(${depotID}, "${manifestFiles[depotID]}", 0)`);
        } else {
            outputEntries.push(`setManifestid(${depotID}, "${manifestFiles[depotID]}", 0)`);
        }
    }

    if (outputEntries.length === 0 && Object.keys(manifestFiles).length === 0) return null;

    return `-- Generated via Manilua Logic\n-- AppID Context: ${appId}\naddappid(${appId})\n` + outputEntries.join('\n');
}

// --- SLASH PARANCSOK REGISZTRÁLÁSA ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('SteamTools .lua generáló és Manifest kereső')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Generálás AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC feloldása? (Alapértelmezett: True)')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Kezdd el gépelni a játék nevét').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC feloldása? (Alapértelmezett: True)'))),
    
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

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ ${client.user.tag} online és parancsok frissítve!`);
    } catch (e) { console.error(e); }
});

// Automatikus Manilua feldolgozás fájlfeltöltéskor
client.on('messageCreate', async message => {
    if (message.author.bot || message.attachments.size === 0) return;

    let db = await Settings.findOne();
    if (!db || !db.allowedChannels.includes(message.channel.id)) return;

    const hasRelevantFiles = message.attachments.some(a => a.name.endsWith('.manifest') || a.name === 'config.vdf');
    if (hasRelevantFiles) {
        const lua = await processFilesToLua(message.attachments);
        if (lua) {
            const file = new AttachmentBuilder(Buffer.from(lua), { name: 'manilua_unlock.lua' });
            message.reply({ 
                content: "✅ Észleltem a manifest/config fájlokat. Generáltam neked egy profi `.lua` feloldót a PiracyBound logika alapján!", 
                files: [file] 
            });
        }
    }
});

// Autocomplete
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    const focused = interaction.options.getFocused();
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
    const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
    const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
    await interaction.respond(suggestions);
});

// Parancskezelő
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // FIX PARANCS
    if (interaction.commandName === 'fix') {
        const fixEmbed = new EmbedBuilder()
            .setTitle('🛠️ SteamTools Segítség')
            .setColor(0xFFA500)
            .addFields(
                { name: '❌ Steam nem indul / Hibaüzenet', value: 'Zárd be a Steamet, töröld az `appinfo.vdf` fájlt a `Steam/appcache` mappából, majd indítsd újra!' },
                { name: '📁 Hogyan kell betölteni?', value: 'A kapott `.lua` fájlt egyszerűen húzd rá a SteamTools lebegő ikonjára!' }
            );
        return interaction.reply({ embeds: [fixEmbed], ephemeral: true });
    }

    // ADMIN PARANCSOK
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Csak az admin!', ephemeral: true });
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
        return interaction.reply({ content: '✅ Kész!', ephemeral: true });
    }

    // MANIFEST GENERÁLÁS
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: '❌ Rossz csatorna!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs jogod!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            if (!steamRes.data[appId].success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const dlcs = gameData.dlc || [];
            
            // LUA Generálás összes DLC-vel
            let lua = `-- Generated by SteamTools Master\naddappid(${appId})\n`;
            if (includeDlc) dlcs.forEach(id => lua += `addappid(${id})\n`);

            let files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
            let statusLines = [`✅ **${gameData.name}** (.lua generálva)`];
            if (includeDlc) statusLines.push(`🔹 DLC-k listázva: ${dlcs.length} db`);

            const zip = await fetchManifestZip(appId);
            if (zip) {
                files.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                statusLines.push(`✅ Manifest ZIP megtalálva.`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 SteamTools: ${gameData.name}`)
                .setColor(0x00FF00)
                .setDescription(statusLines.join('\n') + '\n\n**Tipp:** Ha a Steam nem indul, töröld az `appinfo.vdf`-et!')
                .setFooter({ text: `AppID: ${appId}` });

            await interaction.editReply({ embeds: [embed], files: files });

        } catch (e) { await interaction.editReply("❌ Hiba történt."); }
    }
});

client.login(process.env.DISCORD_TOKEN);
