require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- RENDER KONFIG ---
const app = express();
app.get('/', (req, res) => res.send('SteamTools Master Bot Online!'));
app.listen(process.env.PORT || 3000);

// --- ADATBÁZIS ---
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String]
}));

// --- FORRÁSOK ---
const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes"
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` },
    { name: 'Sushi', url: (id) => `https://raw.githubusercontent.com/sushi-dev55-alt/sushitools-games-repo-alt/refs/heads/main/${id}.zip` },
    { name: 'TwentyTwo', url: (id) => `http://masss.pythonanywhere.com/storage?auth=IEOIJE54esfsipoE56GE4&appid=${id}` },
    { name: 'ManifestHub', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// --- SEGÉDFÜGGVÉNYEK ---

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const url = source.url(id);
            const res = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 3500 });
            if (res.status === 200) {
                // Visszaadjuk az URL-t is, hogy linkelni tudjuk, ha túl nagy
                return { data: res.data, source: source.name, url: url }; 
            }
        } catch (e) { continue; }
    }
    return null;
}

async function getFile(url, fileName) {
    try {
        const head = await axios.head(url, { timeout: 2500 }).catch(() => null);
        if (!head) return null;
        const size = parseInt(head.headers['content-length'] || 0);
        if (size > 24 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return { attachment: new AttachmentBuilder(Buffer.from(res.data), { name: fileName }) };
    } catch (e) { return null; }
}

async function findFixes(appid, gameName) {
    if (gameName) {
        const clean = gameName.replace(/[:™®]/g, "");
        const patterns = [
            `${clean} Online Patch - Tested OK.zip`, 
            `${clean} - Tested OK.zip`, 
            `${clean} Online.zip`, 
            `${clean}.zip`
        ];
        for (const p of patterns) {
            const url = `${FIX_SOURCES.ryuu_fixes}/${encodeURIComponent(p)}`;
            const check = await axios.head(url).catch(() => null);
            if (check && check.status === 200) return { url, name: p };
        }
    }
    const onlineUrl = `${FIX_SOURCES.online}${appid}.zip`;
    const checkOnline = await axios.head(onlineUrl).catch(() => null);
    if (checkOnline && checkOnline.status === 200) return { url: onlineUrl, name: `OnlineFix_${appid}.zip` };
    return { url: null, name: "" };
}

// --- ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    
    // --- AUTOCOMPLETE ---
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused();
        if (!focused) return interaction.respond([]);
        
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focused)}&l=hungarian&cc=HU`;
        const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
        
        const suggestions = res.data.items.map(g => ({ 
            name: `${g.name.substring(0, 80)} (${g.id})`, 
            value: g.id.toString() 
        })).slice(0, 20);
        
        return interaction.respond(suggestions);
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        const sub = interaction.options.getSubcommand();
        const appId = sub === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') ?? true;

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const fix = await findFixes(appId, gameData.name);
            const zip = await fetchManifestZip(appId);
            
            let attachments = [];
            let statusText = "";

            // 1. MANIFEST ZIP (Biztonsági ellenőrzéssel)
            if (zip) {
                // Itt ellenőrizzük a méretet! (24MB limit)
                if (zip.data.length > 24 * 1024 * 1024) {
                    statusText += `⚠️ **Manifest:** Túl nagy (${(zip.data.length / 1024 / 1024).toFixed(1)}MB) -> [Letöltés](${zip.url})\n`;
                } else {
                    attachments.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                    statusText += `✅ **Manifest:** Fájl csatolva (Forrás: ${zip.source})\n`;
                }
            } else {
                statusText += `⚠️ **Manifest:** Nem található a szervereken.\n`;
            }

            // 2. LUA (Csak infó)
            let dlcCount = (gameData.dlc) ? gameData.dlc.length : 0;
            if (includeDlc && dlcCount > 0) {
                statusText += `ℹ️ **DLC:** ${dlcCount} db feloldása (LUA generálva)\n`;
            }

            // 3. ONLINE FIX
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    statusText += `✅ **Online Fix:** Fájl csatolva (\`${fix.name}\`)`;
                } else if (fileData?.tooLarge) {
                    statusText += `⚠️ **Online Fix:** Túl nagy -> [Letöltés](${fix.url})`;
                } else {
                    statusText += `🔗 **Online Fix:** [Letöltés](${fix.url})`;
                }
            } else {
                statusText += `❌ **Online Fix:** Nincs javítás`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(zip ? 0x00FF00 : 0xFFA500)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Fájlok állapota', value: statusText }
                )
                .setFooter({ text: "SteamTools Master - Safe Mode" });

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) {
            console.error(e); // A Render logban látni fogod, mi volt a baj
            // Ha a Discord elutasítja a fájlt (413), akkor küldünk egy hibaüzenetet fájlok nélkül
            await interaction.editReply({ content: "❌ Hiba történt (Valószínűleg túl nagy a fájl), próbáld újra később.", files: [] });
        }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Manifest ZIP és Online Fix letöltő')
            .addSubcommand(sub => 
                sub.setName('id')
                    .setDescription('Generálás AppID alapján')
                    .addStringOption(o => o.setName('appid').setDescription('AppID').setRequired(true))
                    .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k?')))
            .addSubcommand(sub => 
                sub.setName('nev')
                    .setDescription('Keresés név alapján')
                    .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                    .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k?')))
    ].map(c => c.toJSON());

    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
