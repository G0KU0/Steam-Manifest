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
    allowedChannels: [String],
    logChannel: String
}));

// --- MANIFEST ÉS FIX FORRÁSOK ---
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

// Keresés név alapján, ha nem számot adtak meg
async function findAppIdByName(query) {
    try {
        const searchRes = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=hungarian&cc=HU`);
        if (searchRes.data && searchRes.data.items && searchRes.data.items.length > 0) {
            return searchRes.data.items[0].id; // Az első találat AppID-ja
        }
    } catch (e) { console.error("Keresési hiba:", e.message); }
    return null;
}

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

// --- ESEMÉNYKEZELÉS ---

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, user, channelId, member } = interaction;

    const settings = await Settings.findOne();
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isAdmin && !settings?.allowedUsers?.includes(user.id) && !settings?.allowedChannels?.includes(channelId)) {
        return interaction.reply({ content: "❌ Nincs jogosultságod!", ephemeral: true });
    }

    if (commandName === 'manifest' || commandName === 'fix') {
        await interaction.deferReply({ ephemeral: true });
        
        let input = options.getString('query'); // Most már 'query'-nek hívjuk az opciót
        let appId = input;

        // Ha a bemenet nem szám, próbáljunk keresni névre
        if (isNaN(input)) {
            const foundId = await findAppIdByName(input);
            if (!foundId) return interaction.editReply(`❌ Nem találtam játékot ezzel a névvel: **${input}**`);
            appId = foundId.toString();
        }

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId] || !steamRes.data[appId].success) {
                return interaction.editReply("❌ Érvénytelen AppID vagy a Steam API nem válaszol.");
            }

            const gameData = steamRes.data[appId].data;

            if (commandName === 'manifest') {
                const includeDlc = options.getBoolean('dlc') ?? true;
                const dlcs = gameData.dlc || [];

                let lua = `-- SteamTools Unlocker\n-- Játék: ${gameData.name}\nadd_app(${appId})\n`;
                if (includeDlc) dlcs.forEach(id => lua += `add_app(${id})\n`);

                const manifestZip = await fetchManifestZip(appId);
                const fixes = await checkFixes(appId);

                const embed = new EmbedBuilder()
                    .setTitle(`📦 ${gameData.name}`)
                    .setThumbnail(gameData.header_image)
                    .setColor(0x2ecc71)
                    .addFields(
                        { name: 'AppID', value: appId, inline: true },
                        { name: 'DLC-k', value: dlcs.length.toString(), inline: true },
                        { name: 'Fixek', value: `${fixes.generic ? '[Generic](' + fixes.generic + ')' : '❌'} / ${fixes.online ? '[Online](' + fixes.online + ')' : '❌'}` }
                    )
                    .setFooter({ text: manifestZip ? `Forrás: ${manifestZip.source}` : 'Manifest ZIP nem található.' });

                const files = [new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` })];
                if (manifestZip) files.push(new AttachmentBuilder(Buffer.from(manifestZip.data), { name: `manifest_${appId}.zip` }));

                await interaction.editReply({ embeds: [embed], files: files });
            } else {
                // FIX PARANCS LOGIKÁJA
                const fixes = await checkFixes(appId);
                const embed = new EmbedBuilder()
                    .setTitle(`🛠️ Fixek: ${gameData.name}`)
                    .setThumbnail(gameData.header_image)
                    .setColor(0x3498db)
                    .addFields(
                        { name: 'Generic Fix', value: fixes.generic ? `[Letöltés](${fixes.generic})` : '❌ Nem található', inline: true },
                        { name: 'Online Fix', value: fixes.online ? `[Letöltés](${fixes.online})` : '❌ Nem található', inline: true }
                    );
                await interaction.editReply({ embeds: [embed] });
            }

        } catch (error) {
            console.error(error);
            await interaction.editReply("❌ Hiba történt a feldolgozás során.");
        }
    }
});

// --- PARANCSOK REGISZTRÁLÁSA ---
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        const slashCommands = [
            new SlashCommandBuilder()
                .setName('manifest')
                .setDescription('Manifest kereső (Névvel vagy AppID-val)')
                .addStringOption(o => o.setName('query').setDescription('Játék neve vagy AppID-ja').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k feloldása?')),
            new SlashCommandBuilder()
                .setName('fix')
                .setDescription('Fix kereső (Névvel vagy AppID-val)')
                .addStringOption(o => o.setName('query').setDescription('Játék neve vagy AppID-ja').setRequired(true))
        ].map(c => c.toJSON());

        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: slashCommands });
        console.log('Parancsok frissítve!');
    } catch (e) { console.error(e); }
})();

client.login(process.env.DISCORD_TOKEN);
