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

// --- FORRÁSOK AZ LTSTEAMPLUGIN ALAPJÁN (BŐVÍTVE) ---
const MANIFEST_SOURCES = [
    { name: 'LuaTools Bypasses', url: (id) => `https://files.luatools.work/GameBypasses/${id}.zip` },
    { name: 'Ryuu Server', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Morrenus API', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}` }, // api.json-ból
    { name: 'Sushi Repo', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'TwentyTwo Cloud', url: (id) => `http://masss.pythonanywhere.com/storage?auth=IEOIJE54esfsipoE56GE4&appid=${id}` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

// Több mappa ellenőrzése az Online-Fixekhez
const ONLINE_FIX_FOLDERS = [
    "https://files.luatools.work/OnlineFix1/",
    "https://files.luatools.work/OnlineFix2/",
    "https://files.luatools.work/OnlineFix3/",
    "https://files.luatools.work/OnlineFix4/"
];

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

// --- SEGÉDFÜGGVÉNYEK ---

async function fetchFromSources(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 5000 });
            if (res.status === 200) return { data: res.data, source: source.name };
        } catch (e) { continue; }
    }
    return null;
}

// Új Online-Fix kereső funkció több mappával
async function fetchOnlineFix(id) {
    for (const folder of ONLINE_FIX_FOLDERS) {
        try {
            const url = `${folder}${id}.zip`;
            const res = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 5000 });
            if (res.status === 200) return res.data;
        } catch (e) { continue; }
    }
    return null;
}

// --- SLASH PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Manifest és .lua feloldó letöltése (Összes DLC)')
        .addStringOption(o => o.setName('query').setDescription('Játék név vagy ID').setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName('dlc').setDescription('Összes DLC feloldása?').setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('onlinefix')
        .setDescription('Online-Fix letöltése a LuaTools összes szerveréről')
        .addStringOption(o => o.setName('query').setDescription('Játék név vagy ID').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder().setName('fix').setDescription('Steam indítási hiba javítása'),

    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Admin beállítások')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('user').setDescription('User engedélyezése').addUserOption(o => o.setName('target').setDescription('Válaszd ki a felhasználót').setRequired(true)))
        .addSubcommand(s => s.setName('channel').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('target').setDescription('Válaszd ki a csatornát').setRequired(true)))
].map(c => c.toJSON());

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ ${client.user.tag} online - Online-Fix Multi-Folder mód aktív!`);
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

    // --- ONLINE-FIX LETÖLTÉS (TÖBB MAPPA ELLENŐRZÉSE) ---
    if (interaction.commandName === 'onlinefix') {
        const appId = interaction.options.getString('query');
        await interaction.deferReply({ ephemeral: true });

        const fixData = await fetchOnlineFix(appId);

        if (fixData) {
            const file = new AttachmentBuilder(Buffer.from(fixData), { name: `OnlineFix_${appId}.zip` });
            await interaction.editReply({ content: `✅ **Online-Fix** megtalálva és letöltve a LuaTools szervereiről!\n**AppID:** ${appId}`, files: [file] });
        } else {
            await interaction.editReply(`❌ Sajnos a Farming Simulator 25 (${appId}) Online-Fix fájlja jelenleg nem érhető el a LuaTools szerverein (OnlineFix 1-4 mappák átnézve).`);
        }
    }

    // --- MANIFEST ÉS LUA KERESÉS ---
    if (interaction.commandName === 'manifest') {
        const appId = interaction.options.getString('query');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;
        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            const gameData = steamRes.data[appId].data;
            const dlcs = gameData.dlc || [];

            let lua = `-- SteamTools Master Unlocker\naddappid(${appId})\n`;
            if (includeDlc) dlcs.forEach(id => lua += `addappid(${id})\n`);
            const luaFile = new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` });

            const manifest = await fetchFromSources(appId);
            let files = [luaFile];

            if (manifest) {
                files.push(new AttachmentBuilder(Buffer.from(manifest.data), { name: `manifest_${appId}.zip` }));
            }

            await interaction.editReply({ 
                content: `✅ **${gameData.name}** csomag elkészült.\n🔹 DLC-k száma: ${dlcs.length}\n${manifest ? `✅ Manifest találat: ${manifest.source}` : '⚠️ Manifest ZIP nem található a felhőben.'}`, 
                files: files 
            });
        } catch (e) { await interaction.editReply("❌ Hiba a lekérdezés során."); }
    }

    if (interaction.commandName === 'fix') {
        return interaction.reply({ content: "🛠️ **Steam hiba javítása:** Töröld az `appinfo.vdf`-et a `Steam/appcache` mappából!", ephemeral: true });
    }

    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: 'Nincs jogod!', ephemeral: true });
        let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getMember('target') || interaction.options.getChannel('target');
        
        if (sub === 'user') db.allowedUsers.push(target.id);
        if (sub === 'channel') db.allowedChannels.push(target.id);
        await db.save();
        return interaction.reply({ content: '✅ Beállítások mentve!', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
