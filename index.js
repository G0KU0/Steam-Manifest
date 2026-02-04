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
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- KIBŐVÍTETT FORRÁSOK LISTÁJA ---
// A bot sorrendben megy végig rajtuk. Ha az egyiknél 404-et kap, nézi a következőt.
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror 1)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Repository', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Manifest-Database', url: (id) => `https://codeload.github.com/Manifest-Database/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive Hub', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

// --- SLASH PARANCSOK REGISZTRÁLÁSA ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése több forrásból')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés pontos AppID alapján')
                .addStringOption(opt => opt.setName('appid').setDescription('A játék pontos ID-ja').setRequired(true))
                .addBooleanOption(opt => opt.setName('dlc').setDescription('DLC-k keresése is? (True = Igen)').setRequired(false)))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(opt => opt.setName('jateknev').setDescription('Kezdd el gépelni a játék nevét').setRequired(true).setAutocomplete(true))
                .addBooleanOption(opt => opt.setName('dlc').setDescription('DLC-k keresése is? (True = Igen)').setRequired(false))),
    // Admin parancsok maradnak a régiek...
    new SlashCommandBuilder().setName('manage').setDescription('Bot kezelése').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    // ... (itt a többi manage kódod jön)
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

// Steam DLC-k lekérése az áruházból
async function getDlcIds(appId) {
    try {
        const res = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`, { timeout: 3000 });
        if (res.data[appId]?.success) {
            return res.data[appId].data.dlc || [];
        }
    } catch (e) { return []; }
    return [];
}

// Manifest keresése az összes forrásban sorrendben
async function fetchManifestFromAnywhere(appId) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const url = source.url(appId);
            const response = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 5000 });
            if (response.status === 200) {
                return { data: response.data, sourceName: source.name };
            }
        } catch (e) {
            continue; // Ha nem találja (404), megy a következő forrásra
        }
    }
    return null;
}

// --- ESEMÉNYKEZELŐK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`🚀 ${client.user.tag} bevetésre kész!`);
});

client.on('interactionCreate', async interaction => {
    // Autocomplete rész (Steam kereső)
    if (interaction.isAutocomplete()) {
        const query = interaction.options.getFocused();
        if (!query) return interaction.respond([]);
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=hungarian&cc=HU`;
        const search = await axios.get(url).catch(() => ({ data: { items: [] } }));
        const suggestions = search.data.items.map(g => ({ name: `${g.name} (${g.id})`, value: g.id.toString() })).slice(0, 20);
        await interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        let db = await Settings.findOne() || { allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] };
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') || false;

        await interaction.deferReply({ ephemeral: true });

        let results = [];
        let attachments = [];

        // 1. ALAPJÁTÉK KERESÉSE
        const main = await fetchManifestFromAnywhere(appId);
        if (main) {
            attachments.push(new AttachmentBuilder(Buffer.from(main.data), { name: `base_${appId}.zip` }));
            results.push(`✅ Alapjáték (${appId}) - Forrás: ${main.sourceName}`);
        } else {
            results.push(`❌ Alapjáték (${appId}) - Egyik forrásban sem található.`);
        }

        // 2. DLC-K KERESÉSE (ha true)
        if (includeDlc) {
            const dlcs = await getDlcIds(appId);
            if (dlcs.length > 0) {
                results.push(`\n**DLC-k keresése...** (Talált: ${dlcs.length})`);
                // Max 5 DLC-t töltünk le egyszerre, hogy ne akadjon meg a bot
                for (const dlcId of dlcs.slice(0, 5)) {
                    const dlcFile = await fetchManifestFromAnywhere(dlcId);
                    if (dlcFile) {
                        attachments.push(new AttachmentBuilder(Buffer.from(dlcFile.data), { name: `dlc_${dlcId}.zip` }));
                        results.push(`🔹 DLC (${dlcId}) - ✅`);
                    } else {
                        results.push(`🔹 DLC (${dlcId}) - ❌ Nem található`);
                    }
                }
                if (dlcs.length > 5) results.push(`*További ${dlcs.length - 5} DLC-t manuálisan kell lekérned ID alapján.*`);
            } else {
                results.push(`\nℹ️ Ehhez a játékhoz nem találtam DLC-ket a Steam rendszerében.`);
            }
        }

        if (attachments.length === 0) {
            return interaction.editReply('❌ Sajnálom, de egyik forrásunkban sem szerepel ez a tartalom.');
        }

        const embed = new EmbedBuilder()
            .setTitle('📦 Manifest Generátor (Multi-Source)')
            .setColor(includeDlc ? 0xffaa00 : 0x00ff00)
            .setDescription(results.join('\n'))
            .setFooter({ text: 'A ZIP fájlokat csomagold ki a SteamTools mappájába!' });

        await interaction.editReply({ embeds: [embed], files: attachments });
    }
});

client.login(process.env.DISCORD_TOKEN);
