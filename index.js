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

// --- MONGODB ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ] 
});

// --- PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('SteamTools .lua generáló és Manifest kereső')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Generálás AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('Játék AppID').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC feloldása?')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC feloldása?'))),
    
    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Adminisztráció')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Eltávolítás').addUserOption(o => o.setName('target').setDescription('User').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Lista')))
].map(c => c.toJSON());

// --- MANILUA LOGIKA (PIRACYBOUND ALAPJÁN) ---

async function processFilesToLua(attachments, appId = "unknown") {
    let manifestFiles = {};
    let configData = {};

    for (const attachment of attachments.values()) {
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
            // Regex a DecryptionKey kinyeréséhez
            const depotRegex = /"(\d+)"\s*{\s*"DecryptionKey"\s*"([^"]+)"/g;
            let match;
            while ((match = depotRegex.exec(content)) !== null) {
                configData[match[1]] = match[2];
            }
        }
    }

    let outputEntries = [];
    for (const depotID in manifestFiles) {
        if (configData[depotID]) {
            // Precíz szintaxis használata
            outputEntries.push(`addappid(${depotID}, 1, "${configData[depotID]}")\nsetManifestid(${depotID}, "${manifestFiles[depotID]}", 0)`);
        }
    }

    if (outputEntries.length === 0 && Object.keys(manifestFiles).length > 0) {
        // Ha nincs config.vdf, csak a manifesteket írjuk be kulcs nélkül
        for (const depotID in manifestFiles) {
            outputEntries.push(`setManifestid(${depotID}, "${manifestFiles[depotID]}", 0)`);
        }
    }

    if (outputEntries.length === 0) return null;

    return `-- manifest & lua provided by your bot\n-- logic via manilua (piracybound)\naddappid(${appId})\n` + outputEntries.join('\n');
}

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ ${client.user.tag} online!`);
});

// Fájl feltöltés figyelése (Manuális mód)
client.on('messageCreate', async message => {
    if (message.author.bot || message.attachments.size === 0) return;

    let db = await Settings.findOne();
    if (!db || !db.allowedChannels.includes(message.channel.id)) return;

    const hasRelevantFiles = message.attachments.some(a => a.name.endsWith('.manifest') || a.name === 'config.vdf');
    if (hasRelevantFiles) {
        const lua = await processFilesToLua(message.attachments);
        if (lua) {
            const file = new AttachmentBuilder(Buffer.from(lua), { name: 'generated_unlock.lua' });
            message.reply({ content: "✅ Sikeresen feldolgoztam a fájlokat a PiracyBound logikájával!", files: [file] });
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        await interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    if (interaction.commandName === 'manifest') {
        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamData = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            if (!steamData.data[appId].success) return interaction.editReply("❌ Hiba.");

            const game = steamData.data[appId].data;
            const dlcs = game.dlc || [];

            // Új szintaxis használata a .lua-ban
            let luaScript = `-- Generated by SteamTools Master Bot\n-- Syntax: PiracyBound/manilua\n\naddappid(${appId})\n`;
            if (includeDlc) {
                dlcs.forEach(id => luaScript += `addappid(${id})\n`);
            }

            const file = new AttachmentBuilder(Buffer.from(luaScript), { name: `unlock_${appId}.lua` });
            const embed = new EmbedBuilder()
                .setTitle(`📦 Master Unlocker: ${game.name}`)
                .setColor(0x00FF00)
                .setDescription(`A PiracyBound szintaxissal legeneráltam a feloldót.\n\n**Tipp:** Ha van saját \`config.vdf\` fájlod, töltsd fel ide a \`.manifest\` fájlokkal együtt a pontosabb eredményért!`)
                .setFooter({ text: `AppID: ${appId} | DLC-k: ${dlcs.length}` });

            await interaction.editReply({ embeds: [embed], files: [file] });

        } catch (e) { await interaction.editReply("❌ Hiba."); }
    }
});

client.login(process.env.DISCORD_TOKEN);
