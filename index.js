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
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 3500 });
            if (res.status === 200) return { data: res.data, source: source.name };
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
    
    // --- AUTOCOMPLETE (Maradt a jól működő verzió) ---
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

            // --- 1. CSAK EZT A FÁJLT KÜLDJÜK (Ami mindent tud) ---
            let lua = `-- SteamTools Master Unlocker\n-- Game: ${gameData.name}\n\nadd_app(${appId}, "${gameData.name}")\n`;
            if (gameData.dlc && includeDlc) {
                gameData.dlc.forEach(id => lua += `add_dlc(${id})\n`);
                statusText += `✅ **DLC-k:** ${gameData.dlc.length} db hozzáadva a fájlhoz!\n`;
            } else {
                statusText += `ℹ️ **DLC:** Nincs DLC vagy ki lett kapcsolva.\n`;
            }
            // Itt adjuk hozzá az EGYETLEN fontos fájlt
            attachments.push(new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` }));

            // --- 2. MANIFEST (Csak infó, fájlt NEM küldünk) ---
            if (zip) {
                // KIVETTEM: attachments.push(...) -> Nem küldi el a ZIP-et, hogy ne zavarjon
                statusText += `✅ **Manifest:** Elérhető a szerveren (${zip.source}), de a LUA elég a feloldáshoz.\n`;
            } else {
                statusText += `⚠️ **Manifest:** Nem található külön fájlként.\n`;
            }

            // --- 3. FIX (Csak ha van, és fontos) ---
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    statusText += `✅ **Online Fix:** Mellékelve (\`${fix.name}\`)`;
                } else if (fileData?.tooLarge) {
                    statusText += `⚠️ **Online Fix:** Túl nagy -> [Letöltés](${fix.url})`;
                } else {
                    statusText += `🔗 **Online Fix:** [Letöltés](${fix.url})`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(0x00FF00)
                .setDescription(`**Letöltötted az "All-in-One" feloldó fájlt!**\nEbben benne van az alapjáték és az összes DLC kódja is.`)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Részletek', value: statusText }
                )
                .setFooter({ text: "Húzd a .lua fájlt a SteamTools-ra!" });

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Hiba történt.");
        }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('All-in-One feloldó generálása')
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
