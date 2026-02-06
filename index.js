require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, Events 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- 1. KONFIGURÁCIÓ (Limit szintek) ---
const LIMITS = {
    1: 15,       // Rang 1: Napi 15 db
    2: 30,       // Rang 2: Napi 30 db
    3: Infinity  // Rang 3: Végtelen
};

// --- 2. WEBSZERVER (Renderhez) ---
const app = express();
app.get('/', (req, res) => res.send('SteamTools Master Bot Online!'));
app.listen(process.env.PORT || 3000);

// --- 3. ADATBÁZIS KAPCSOLÓDÁS ---
mongoose.connect(process.env.MONGODB_URI).catch(err => console.error("MongoDB hiba:", err));

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    rank: { type: Number, default: 1 }, 
    dailyUsage: { type: Number, default: 0 },
    lastDate: { type: String, default: '' } 
});
const UserModel = mongoose.model('User', UserSchema);

const ConfigSchema = new mongoose.Schema({
    allowedChannels: [String]
});
const ConfigModel = mongoose.model('Config', ConfigSchema);

// --- 4. FORRÁSOK LISTÁJA ---
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

// --- 5. SEGÉDFÜGGVÉNYEK ---

async function checkQuota(userId) {
    const today = new Date().toISOString().split('T')[0]; 
    let user = await UserModel.findOne({ userId });

    if (!user) return { allowed: false, error: "❌ Nem vagy hozzáadva a rendszerhez! Kérj engedélyt az admintól." };

    if (user.lastDate !== today) {
        user.dailyUsage = 0;
        user.lastDate = today;
        await user.save();
    }

    const limit = LIMITS[user.rank] || 15;
    if (user.dailyUsage >= limit) {
        return { allowed: false, error: `❌ Elérted a napi limitedet! (${user.dailyUsage}/${limit})` };
    }

    return { allowed: true, user };
}

async function fetchManifestZip(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const url = source.url(id);
            const res = await axios({ method: 'get', url: url, responseType: 'arraybuffer', timeout: 3500 });
            if (res.status === 200) {
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
        // Szigorúbb előzetes ellenőrzés (50MB fölött meg se próbálja)
        if (size > 50 * 1024 * 1024) return { tooLarge: true, size: (size / 1024 / 1024).toFixed(1) };
        
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return { attachment: new AttachmentBuilder(Buffer.from(res.data), { name: fileName }) };
    } catch (e) { return null; }
}

async function findFixes(appid, gameName) {
    if (gameName) {
        const clean = gameName.replace(/[:™®]/g, "");
        const patterns = [`${clean} Online Patch - Tested OK.zip`, `${clean} - Tested OK.zip`, `${clean} Online.zip`, `${clean}.zip`];
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

// --- 6. ESEMÉNYEK ---

client.on(Events.InteractionCreate, async interaction => {
    
    // Autocomplete
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

    // ADMIN
    if (interaction.commandName === 'admin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== process.env.ADMIN_ID) {
            return interaction.reply({ content: "❌ Nincs jogosultságod!", ephemeral: true });
        }

        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        if (group === 'user') {
            const target = interaction.options.getUser('target');
            if (sub === 'add') {
                const rank = interaction.options.getInteger('rank');
                await UserModel.findOneAndUpdate({ userId: target.id }, { userId: target.id, rank: rank }, { upsert: true, new: true });
                return interaction.reply({ content: `✅ **${target.tag}** rangja: **${rank}**`, ephemeral: true });
            }
            if (sub === 'remove') {
                await UserModel.findOneAndDelete({ userId: target.id });
                return interaction.reply({ content: `🗑️ **${target.tag}** törölve.`, ephemeral: true });
            }
        }

        if (group === 'channel') {
            const targetChannel = interaction.options.getChannel('target') || interaction.channel;
            let config = await ConfigModel.findOne() || await ConfigModel.create({ allowedChannels: [] });
            if (sub === 'add') {
                if (!config.allowedChannels.includes(targetChannel.id)) {
                    config.allowedChannels.push(targetChannel.id);
                    await config.save();
                    return interaction.reply({ content: `✅ Csatorna engedélyezve: ${targetChannel}`, ephemeral: true });
                }
                return interaction.reply({ content: `⚠️ Már engedélyezve van.`, ephemeral: true });
            }
            if (sub === 'remove') {
                config.allowedChannels = config.allowedChannels.filter(id => id !== targetChannel.id);
                await config.save();
                return interaction.reply({ content: `🚫 Csatorna tiltva.`, ephemeral: true });
            }
        }
    }

    // MANIFEST
    if (interaction.commandName === 'manifest') {
        const sub = interaction.options.getSubcommand();
        const appId = sub === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');

        let config = await ConfigModel.findOne();
        if (config && config.allowedChannels.length > 0 && !config.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: "❌ Rossz csatorna!", ephemeral: true });
        }

        const quota = await checkQuota(interaction.user.id);
        if (!quota.allowed) return interaction.reply({ content: quota.error, ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            const steamRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=hungarian`);
            if (!steamRes.data[appId]?.success) return interaction.editReply("❌ Játék nem található.");

            const gameData = steamRes.data[appId].data;
            const fix = await findFixes(appId, gameData.name);
            const zip = await fetchManifestZip(appId);
            
            let attachments = [];
            let statusText = "";

            // Manifest Kezelés
            if (zip) {
                // 48 MB felett biztosan link (Discord szerver boosttól függetlenül)
                if (zip.data.length > 48 * 1024 * 1024) { 
                    statusText += `⚠️ **Manifest:** Túl nagy -> [Letöltés](${zip.url})\n`;
                } else {
                    attachments.push(new AttachmentBuilder(Buffer.from(zip.data), { name: `manifest_${appId}.zip` }));
                    statusText += `✅ **Manifest:** Fájl csatolva\n`;
                }
            } else {
                statusText += `⚠️ **Manifest:** Nincs találat.\n`;
            }

            // Fix Kezelés
            if (fix.url) {
                const fileData = await getFile(fix.url, fix.name);
                if (fileData?.attachment) {
                    attachments.push(fileData.attachment);
                    statusText += `✅ **Online Fix:** Fájl csatolva\n`;
                } else {
                    statusText += `🔗 **Online Fix:** [Letöltés](${fix.url})`;
                }
            }

            quota.user.dailyUsage += 1;
            await quota.user.save();
            const remaining = LIMITS[quota.user.rank] === Infinity ? "∞" : LIMITS[quota.user.rank] - quota.user.dailyUsage;

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${gameData.name}`)
                .setThumbnail(gameData.header_image)
                .setColor(0x00FF00)
                .addFields(
                    { name: 'AppID', value: appId, inline: true },
                    { name: 'Fájlok', value: statusText },
                    { name: 'Napi Kvóta', value: `Használva: ${quota.user.dailyUsage} | Maradt: ${remaining}` }
                )
                .setFooter({ text: "SteamTools Master" });

            // --- FAIL-SAFE KÜLDÉS ---
            try {
                // 1. Próbáljuk meg elküldeni a fájlokat
                await interaction.editReply({ embeds: [embed], files: attachments });
            } catch (sendError) {
                // 2. HA HIBA VAN (pl. túl nagy a fájl a barátod szerverén)
                console.log("Feltöltési hiba, váltás linkre:", sendError.message);
                
                // Átírjuk a szöveget linkesre és töröljük a fájlokat
                let fallbackText = "";
                if (zip) fallbackText += `🔗 **Manifest:** [LETÖLTÉS LINK](${zip.url})\n`;
                if (fix.url) fallbackText += `🔗 **Online Fix:** [LETÖLTÉS LINK](${fix.url})\n`;
                
                const fallbackEmbed = new EmbedBuilder()
                    .setTitle(`📦 ${gameData.name} (Link Mód)`)
                    .setDescription(`⚠️ **A Discord visszautasította a fájlt.**\n(Valószínűleg túl nagy a szervernek).\n\nHasználd a lenti linkeket:\n\n${fallbackText}`)
                    .setThumbnail(gameData.header_image)
                    .setColor(0xFFA500);

                // Küldés újra, de most fájlok nélkül (files: [])
                await interaction.editReply({ embeds: [fallbackEmbed], files: [] });
            }

        } catch (e) {
            console.error(e);
            await interaction.editReply({ content: "❌ Váratlan hiba történt.", files: [] });
        }
    }
});

// --- 7. START ---
client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('manifest')
            .setDescription('Játék letöltése')
            .addSubcommand(sub => sub.setName('id').setDescription('AppID alapján').addStringOption(o => o.setName('appid').setDescription('AppID').setRequired(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?')))
            .addSubcommand(sub => sub.setName('nev').setDescription('Név alapján').addStringOption(o => o.setName('jateknev').setDescription('Név').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('dlc').setDescription('DLC?'))),
        new SlashCommandBuilder()
            .setName('admin')
            .setDescription('Bot kezelése')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommandGroup(group => group.setName('user').setDescription('Felhasználók').addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true)).addIntegerOption(o => o.setName('rank').setDescription('Rang').setRequired(true).addChoices({ name: 'Rang 1', value: 1 }, { name: 'Rang 2', value: 2 }, { name: 'Rang 3', value: 3 }))).addSubcommand(sub => sub.setName('remove').setDescription('Törlés').addUserOption(o => o.setName('target').setDescription('Felhasználó').setRequired(true))))
            .addSubcommandGroup(group => group.setName('channel').setDescription('Csatornák').addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés').addChannelOption(o => o.setName('target').setDescription('Csatorna'))).addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('target').setDescription('Csatorna'))))
    ].map(c => c.toJSON());

    const clientId = process.env.CLIENT_ID || client.user.id;
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
