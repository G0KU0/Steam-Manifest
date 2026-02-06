require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits 
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

// --- FIX ÉS MANIFEST FORRÁSOK ---
const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes" // Per jel nélkül a végén
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` }
];

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// --- SEGÉDFÜGGVÉNYEK ---

async function getFile(url, fileName) {
    try {
        const head = await axios.head(url, { timeout: 2500 }).catch(() => null);
        if (!head) return null;

        const size = parseInt(head.headers['content-length'] || 0);
        if (size > 24 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };

        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000 });
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

client.on('interactionCreate', async interaction => {
    // --- AUTOCOMPLETE JAVÍTÁS ---
    if (interaction.isAutocomplete()) {
        try {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name !== 'jateknev') return;

            const query = focusedOption.value;
            if (!query || query.trim().length < 2) {
                return await interaction.respond([]);
            }

            // Gyors kérés a Steam felé
            const searchRes = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=hungarian&cc=HU`, { timeout: 2200 });
            
            if (!searchRes.data || !searchRes.data.items) return await interaction.respond([]);

            const choices = searchRes.data.items.map(g => ({
                name: `${g.name.substring(0, 80)} (${g.id})`,
                value: g.id.toString()
            })).slice(0, 20);

            await interaction.respond(choices);
        } catch (e) {
            // Ha hiba van vagy lejárt az idő, üres választ küldünk, hogy ne fagyjon le
            if (!interaction.responded) {
                try { await interaction.respond([]); } catch (err) {}
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        await interaction.deferReply({ ephemeral: true });
        const appId = interaction.options.getString('jateknev');

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const fix = await findFixes(appId, gameData.name);
            let attachments = [];
            let fixStatus = "❌ Nem található";

            // LUA
            let lua = `-- SteamTools Master Unlocker\nadd_app(${appId}, "${gameData.name}")\n`;
            if (gameData.dlc) gameData.dlc.forEach(id => lua += `add_dlc(${id})\n`);
            attachments.push(new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` }));

            // Fix feltöltés vagy link
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    fixStatus = `✅ **Fájl csatolva:** \`${fix.name}\``;
                } else if (fileData?.tooLarge) {
                    fixStatus = `⚠️ **Túl nagy (${fileData.size}MB):** [Közvetlen letöltés](${fix.url})`;
                } else {
                    fixStatus = `🔗 **Link:** [Letöltés](${fix.url})`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(fix.url ? 0x00FF00 : 0x3498db)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Fix állapota', value: fixStatus }
                );

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) {
            await interaction.editReply("❌ Hiba történt a generálás során.");
        }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Manifest és Online Fix kereső')
            .addStringOption(o => o.setName('jateknev').setDescription('Írd a játék nevét...').setRequired(true).setAutocomplete(true))
    ].map(c => c.toJSON());

    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
