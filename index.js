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
app.get('/', (req, res) => res.send('SteamTools Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- MANIFEST ÉS LUA FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Depot-Mirror', url: (id) => `https://codeload.github.com/Manifest-Database/ManifestHub/zip/refs/heads/${id}` }
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
        .setDescription('SteamTools kompatibilis fájlok és DLC-k letöltése')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés pontos AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('A játék AppID-ja').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Szeretnéd az összes létező DLC-t is letölteni?')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Írd be a játék nevét').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('Szeretnéd az összes létező DLC-t is letölteni?'))),
    
    new SlashCommandBuilder()
        .setName('fix')
        .setDescription('Gyakori SteamTools hibák és megoldások (FAQ)'),

    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Bot kezelése (Admin)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Jogosultság adása').addUserOption(o => o.setName('target').setDescription('Válaszd ki a felhasználót').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Jogosultság elvétele').addUserOption(o => o.setName('target').setDescription('Válaszd ki a felhasználót').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Engedélyezett felhasználók listája')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('channel').setDescription('Válaszd ki a csatornát').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('channel').setDescription('Válaszd ki a csatornát').setRequired(true))))
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function fetchFile(id) {
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
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// --- LOGOLÁS ---
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
        console.log(`✅ ${client.user.tag} bejelentkezve és parancsok frissítve!`);
    } catch (e) { console.error('Hiba a parancsoknál:', e); }
});

// Autocomplete
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    const focused = interaction.options.getFocused();
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
    const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
    const suggestions = res.data.items.map(g => ({ name: `${g.name.substring(0, 80)} (ID: ${g.id})`, value: g.id.toString() })).slice(0, 20);
    await interaction.respond(suggestions);
});

// Parancskezelő
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // FIX / FAQ PARANCS
    if (interaction.commandName === 'fix') {
        const fixEmbed = new EmbedBuilder()
            .setTitle('🛠️ SteamTools Segítség & FAQ')
            .setColor(0xFFA500)
            .addFields(
                { name: '❌ "Content Configuration Unavailable"', value: 'Töröld az `appinfo.vdf` fájlt a `Steam/appcache` mappából és indítsd újra a Steamet.' },
                { name: '❌ "PURCHASE" gomb van a "PLAY" helyett', value: 'A SteamTools verziód elavult vagy nincs elindítva az unlocker.' },
                { name: '📁 Hogyan kell használni?', value: 'A letöltött ZIP-et csomagold ki, és a benne lévő fájlt húzd rá a SteamTools lebegő ikonjára!' },
                { name: '🛡️ Windows Defender hiba', value: 'Add hozzá a Steam és a SteamTools mappáját a kivételekhez.' }
            );
        return interaction.reply({ embeds: [fixEmbed], ephemeral: true });
    }

    // MANAGE PARANCS
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Csak az admin kezelheti a botot!', ephemeral: true });
        
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('target') || interaction.options.getChannel('channel');

        if (group === 'user') {
            if (sub === 'add') { if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id); }
            else if (sub === 'remove') { db.allowedUsers = db.allowedUsers.filter(id => id !== target.id); }
            else if (sub === 'list') return interaction.reply({ content: `**Engedélyezett tagok:** ${db.allowedUsers.map(id => `<@${id}>`).join(', ') || 'Senki'}`, ephemeral: true });
        } else if (group === 'channel') {
            if (sub === 'add') { if (!db.allowedChannels.includes(target.id)) db.allowedChannels.push(target.id); }
            else if (sub === 'remove') { db.allowedChannels = db.allowedChannels.filter(id => id !== target.id); }
        }
        await db.save();
        return interaction.reply({ content: '✅ Beállítások frissítve!', ephemeral: true });
    }

    // MANIFEST / DLC GENERÁLÁS
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: '❌ Ebben a csatornában a bot nem használható!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs jogosultságod a letöltéshez!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') || false;

        await interaction.deferReply({ ephemeral: true });

        let allFiles = [];
        let status = [];

        // 1. Alapjáték
        const main = await fetchFile(appId);
        if (main) {
            allFiles.push(new AttachmentBuilder(Buffer.from(main.data), { name: `base_${appId}.zip` }));
            status.push(`✅ **Alapjáték (${appId})** - [${main.source}]`);
        } else {
            status.push(`❌ **Alapjáték (${appId})** - Nem található egyik forrásban sem.`);
        }

        // 2. Összes DLC keresése (Batching segítségével)
        if (includeDlc) {
            const dlcRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`).catch(() => null);
            const dlcs = dlcRes?.data[appId]?.data?.dlc || [];

            if (dlcs.length > 0) {
                status.push(`\n**DLC-k ellenőrzése...** (${dlcs.length} db)`);
                for (const dlcId of dlcs) {
                    const dlcFile = await fetchFile(dlcId);
                    if (dlcFile) {
                        allFiles.push(new AttachmentBuilder(Buffer.from(dlcFile.data), { name: `dlc_${dlcId}.zip` }));
                    }
                }
                status.push(`✅ Talált DLC manifestek: ${allFiles.length - (main ? 1 : 0)} db`);
            } else {
                status.push(`\nℹ️ Ehhez a játékhoz nincsenek külön DLC-k a Steam-en.`);
            }
        }

        if (allFiles.length === 0) return interaction.editReply('❌ Sajnálom, nem találtam letölthető fájlt.');

        // 3. Küldés 10-esével (Discord limit miatt)
        const chunks = chunkArray(allFiles, 10);
        for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(i === 0 ? '📦 Letöltési Csomag' : `📦 További DLC-k (${i + 1}/${chunks.length})`)
                .setColor(0x2ecc71)
                .setDescription(i === 0 ? status.join('\n') + '\n\n**Használat:** Csomagold ki, és a tartalmukat húzd a SteamTools ikonjára!' : 'További manifest fájlok csatolva.');

            if (i === 0) {
                await interaction.editReply({ embeds: [embed], files: chunks[i] });
            } else {
                await interaction.followUp({ embeds: [embed], files: chunks[i], ephemeral: true });
            }
        }
        await sendLog('📥 Letöltés', `**User:** ${interaction.user.tag}\n**AppID:** ${appId}\n**DLC-k:** ${includeDlc}`);
    }
});

client.login(process.env.DISCORD_TOKEN);
