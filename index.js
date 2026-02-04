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
app.get('/', (req, res) => res.send('Manifest & Depot Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Depot-Mirror', url: (id) => `https://codeload.github.com/Manifest-Database/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// --- SLASH PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest és Depot kulcsok letöltése')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC keresése?')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC keresése?'))),
    
    // Új hibaelhárítási parancs a dokumentáció alapján
    new SlashCommandBuilder()
        .setName('fix')
        .setDescription('Gyakori SteamTools hibák javítása'),

    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Admin beállítások')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Eltávolítás').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Lista')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák')
                .addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('channel').setDescription('Csatorna').setRequired(true))))
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function getManifestWithFallback(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 4500 });
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

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ ${client.user.tag} üzemkész!`);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focusedValue = interaction.options.getFocused();
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        await interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // Hiba javítási tippek a dokumentációból
    if (interaction.commandName === 'fix') {
        const fixEmbed = new EmbedBuilder()
            .setTitle('🛠️ SteamTools Hibaelhárítás')
            .setColor(0xFFA500)
            .addFields(
                { name: 'Hiba: "Content Configuration Unavailable"', value: 'Menj a `C:\\Program Files (x86)\\Steam\\appcache` mappába és töröld az `appinfo.vdf` fájlt.' },
                { name: 'Hiba: A játék "PURCHASE" gombot mutat', value: 'A SteamTools verziód elavult. Telepítsd újra a legfrissebb verziót.' },
                { name: 'Windows Defender törli a fájlokat?', value: 'Add hozzá a játék mappáját a Windows Defender kivételekhez.' }
            );
        return interaction.reply({ embeds: [fixEmbed], ephemeral: true });
    }

    // MANAGE parancs (Admin)
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Nincs jogod!', ephemeral: true });
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('target') || interaction.options.getChannel('channel');

        if (group === 'user') {
            if (sub === 'add') { if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id); }
            if (sub === 'remove') db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
            if (sub === 'list') return interaction.reply({ content: `Tagok: ${db.allowedUsers.map(id => `<@${id}>`).join(', ')}`, ephemeral: true });
        }
        if (group === 'channel') {
            if (sub === 'add') { if (!db.allowedChannels.includes(target.id)) db.allowedChannels.push(target.id); }
            if (sub === 'remove') db.allowedChannels = db.allowedChannels.filter(id => id !== target.id);
        }
        await db.save();
        return interaction.reply({ content: '✅ Beállítások mentve!', ephemeral: true });
    }

    // MANIFEST & DEPOT generálás
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: '❌ Rossz csatorna!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs engedélyed!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') || false;

        await interaction.deferReply({ ephemeral: true });

        let allFiles = [];
        let logLines = [];

        // Alapjáték keresése
        const main = await getManifestWithFallback(appId);
        if (main) {
            allFiles.push(new AttachmentBuilder(Buffer.from(main.data), { name: `manifest_${appId}.zip` }));
            logLines.push(`✅ **Alapjáték (${appId})** megtalálva.`);
        } else {
            logLines.push(`❌ **Alapjáték (${appId})** nem található a repókban.`);
        }

        // DLC-k keresése
        if (includeDlc) {
            const dlcData = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`).catch(() => null);
            const dlcs = dlcData?.data[appId]?.data?.dlc || [];

            if (dlcs.length > 0) {
                logLines.push(`\n**DLC-k keresése folyamatban...** (${dlcs.length} db)`);
                for (const dlcId of dlcs) {
                    const dlcFile = await getManifestWithFallback(dlcId);
                    if (dlcFile) allFiles.push(new AttachmentBuilder(Buffer.from(dlcFile.data), { name: `dlc_${dlcId}.zip` }));
                }
                logLines.push(`✅ Letölthető DLC-k: ${allFiles.length - (main ? 1 : 0)} db`);
            }
        }

        if (allFiles.length === 0) return interaction.editReply('❌ Egyik forrásban sem található meg ez a játék.');

        const chunks = chunkArray(allFiles, 10);
        for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(i === 0 ? '📦 SteamTools Csomag' : `📦 További fájlok (${i + 1}/${chunks.length})`)
                .setColor(0x00FF00)
                .setDescription(i === 0 ? logLines.join('\n') + '\n\n**Hogyan használd?**\nCsomagold ki a ZIP-eket, és a tartalmukat (főleg a .lua fájlokat) húzd rá a SteamTools lebegő ikonjára!' : 'További kért manifest fájlok csatolva.');

            if (i === 0) await interaction.editReply({ embeds: [embed], files: chunks[i] });
            else await interaction.followUp({ embeds: [embed], files: chunks[i], ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
