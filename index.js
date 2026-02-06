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

// --- FORRÁSOK (Javítva a Ryuu útvonal a visszajelzésed alapján) ---
const FIX_SOURCES = {
    online: "https://files.luatools.work/OnlineFix1/",
    ryuu_fixes: "https://generator.ryuu.lol/fixes" // Itt töröltem a / jelet a végéről
};

const MANIFEST_SOURCES = [
    { name: 'Morrenus', url: (id) => `https://manifest.morrenus.xyz/api/v1/manifest/${id}?api_key=${process.env.MORRENUS_API_KEY}` },
    { name: 'Ryuu', url: (id) => `http://167.235.229.108/${id}` }
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// --- SEGÉDFÜGGVÉNYEK ---

// Fájl letöltése és Attachment készítése (25MB limit kezeléssel)
async function getFile(url, fileName) {
    try {
        const head = await axios.head(url, { timeout: 3000 }).catch(() => null);
        if (!head) return null;

        const size = parseInt(head.headers['content-length'] || 0);
        // Discord limit: 25MB (itt 24-nél megállunk a biztonság kedvéért)
        if (size > 24 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };

        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return { attachment: new AttachmentBuilder(Buffer.from(res.data), { name: fileName }) };
    } catch (e) { return null; }
}

async function findFixes(appid, gameName) {
    // Ryuu keresés név alapján (az index.html-ben látott Puppet Team / Online minták alapján)
    if (gameName) {
        const clean = gameName.replace(/[:™®]/g, "");
        const patterns = [
            `${clean} Online Patch - Tested OK.zip`, 
            `${clean} - Tested OK.zip`, 
            `${clean} Online.zip`,
            `${clean}.zip`
        ];
        
        for (const p of patterns) {
            // Itt rakjuk ki manuálisan a / jelet a bázis és a fájlnév közé
            const url = `${FIX_SOURCES.ryuu_fixes}/${encodeURIComponent(p)}`;
            const check = await axios.head(url).catch(() => null);
            if (check && check.status === 200) return { url, name: p };
        }
    }

    // Ha nincs Ryuu fix, megnézzük AppID alapján a Luatools-on
    const onlineUrl = `${FIX_SOURCES.online}${appid}.zip`;
    const checkOnline = await axios.head(onlineUrl).catch(() => null);
    if (checkOnline && checkOnline.status === 200) return { url: onlineUrl, name: `OnlineFix_${appid}.zip` };
    
    return { url: null, name: "" };
}

// --- ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    // Villámgyors Autocomplete a név szerinti kereséshez
    if (interaction.isAutocomplete()) {
        try {
            const focusedValue = interaction.options.getFocused();
            if (!focusedValue || focusedValue.length < 2) return interaction.respond([]);

            const res = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`, { timeout: 2000 });
            
            const choices = res.data.items.map(g => ({
                name: `${g.name.substring(0, 80)} (${g.id})`,
                value: g.id.toString()
            })).slice(0, 20);

            await interaction.respond(choices);
        } catch (e) {
            if (!interaction.responded) await interaction.respond([]);
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
            let fixStatus = "❌ Nem található javítás a szervereken.";

            // 1. .LUA generálás
            let lua = `-- SteamTools Master Unlocker\n-- Game: ${gameData.name}\n\nadd_app(${appId}, "${gameData.name}")\n`;
            if (gameData.dlc) gameData.dlc.forEach(id => lua += `add_dlc(${id})\n`);
            attachments.push(new AttachmentBuilder(Buffer.from(lua), { name: `unlock_${appId}.lua` }));

            // 2. Fix keresés és csatolás
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    fixStatus = `✅ **Fix fájl csatolva:** \`${fix.name}\``;
                } else if (fileData?.tooLarge) {
                    fixStatus = `⚠️ **Fix túl nagy (${fileData.size}MB)**, ezért csak linket küldök: [Letöltés](${fix.url})`;
                } else {
                    fixStatus = `🔗 **Fix elérhető (Link):** [Letöltés](${fix.url})`;
                }
            }

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(fix.url ? 0x00FF00 : 0x3498db)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Online Fix Állapot', value: fixStatus }
                )
                .setFooter({ text: "SteamTools Master | Források: Ryuu Fixes & Luatools" });

            await interaction.editReply({ embeds: [embed], files: attachments });

        } catch (e) {
            console.error(e);
            await interaction.editReply("❌ Hiba történt a generálás során.");
        }
    }
});

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Manifest, LUA és Online Fix kereső')
            .addStringOption(o => o.setName('jateknev').setDescription('Kezdd el gépelni a játék nevét...').setRequired(true).setAutocomplete(true))
    ].map(c => c.toJSON());

    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("✅ Bot online és Ryuu forrás frissítve!");
});

client.login(process.env.DISCORD_TOKEN);
