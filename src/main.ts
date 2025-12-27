import { App, Plugin, TFile } from 'obsidian';
import { FileView, WorkspaceLeaf } from 'obsidian';
import Panzoom from '@panzoom/panzoom';

export const VIEW_TYPE_IMAGE = 'image-viewer';

const IMAGE_EXTENSIONS = [
	"png","jpg","jpeg","gif",
	"bmp","svg","webp","avif",
	"tiff","ico","heic"
];

export default class ImageViewer extends Plugin {
	private prevExtToView = new Map<string, string>();

	async onload() {
		this.registerView(VIEW_TYPE_IMAGE, (leaf) => new ImageView(leaf));
		for (const ext of IMAGE_EXTENSIONS) {
			const prev =
			(this.app.viewRegistry as any).getTypeByExtension?.(ext) ??
			(this.app.viewRegistry as any).extensions?.[ext];

			if (typeof prev === "string" && prev.length > 0) {
				this.prevExtToView.set(ext, prev);
			}
		}

		this.app.viewRegistry.unregisterExtensions([...IMAGE_EXTENSIONS]);
		this.registerExtensions([...IMAGE_EXTENSIONS], VIEW_TYPE_IMAGE);
	}

	onunload() {
		try {
			this.app.viewRegistry.unregisterExtensions([...IMAGE_EXTENSIONS]);
		} catch (_) {}

		const groups = new Map<string, string[]>();
		for (const ext of IMAGE_EXTENSIONS) {
			const prevType = this.prevExtToView.get(ext) ?? "image"; // фолбэк на штатный
			if (!groups.has(prevType)) groups.set(prevType, []);
			groups.get(prevType)!.push(ext);
		}

		for (const [type, exts] of groups) {
			try {
				this.app.viewRegistry.registerExtensions(exts, type);
			} catch (_) {}
		}

		this.prevExtToView.clear();
	}

}

export class ImageView extends FileView {
	private mainImageEl!: HTMLImageElement;
	private thumbnailStrip!: HTMLElement;
	private displayAreaEl!: HTMLElement;
	private panzoom?: PanzoomObject;

	private imageList: TFile[] = []; // Список изображений в текущей папке
	private currentIndex: number = -1; // Индекс текущего изображения

	private domBuilt = false;

	private readonly maxZoom = 5.0;
	private readonly minZoom = 0.25;
	private readonly zoomStep = 0.5;

    private swipeStartX = 0;
    private swipeStartTime = 0;
    private readonly SWIPE_THRESHOLD = 60; // пикселей
    private readonly SWIPE_MAX_TIME = 300; // мс
    private lastTapTime = 0;

	getViewType()                    { return VIEW_TYPE_IMAGE; }
	getDisplayText(): string         { return 'Image Viewer'; }
	getIcon(): string                { return 'images'; }
	constructor(leaf: WorkspaceLeaf) { super(leaf); }
	canAcceptExtension(extension: string): boolean {
 		return IMAGE_EXTENSIONS.includes(extension.toLowerCase());
	}

    async onLoadFile(file: TFile): Promise<void> {
		if (!this.domBuilt) this.buildDom();
		await this.loadImage(file);
	}

	private buildDom(): void {
		const isMobile = (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches);
		const container = this.contentEl;
		container.empty();

		const wrapper = container.createEl('div', { cls: 'image-gallery-container' });
		this.displayAreaEl = wrapper.createEl('div', { cls: 'image-display-area' });
		this.mainImageEl = this.displayAreaEl.createEl('img', {
			cls: 'main-image',
			attr: { src: '' }
		});

		this.thumbnailStrip = wrapper.createEl('div', { cls: 'thumbnail-strip' });

		// Panzoom сам повесит Pointer Events на this.mainImageEl (пан + pinch)
		this.panzoom = Panzoom(this.mainImageEl, {
			maxScale: this.maxZoom,
			minScale: !isMobile ? this.minZoom : 1,
			step: !isMobile ? this.zoomStep : 1,
			panOnlyWhenZoomed: true,
			pinchAndPan: true,
			cursor: 'default',
		});

		this.setupEventListeners();
		this.domBuilt = true;
	}

	private setupEventListeners(): void {
		this.registerDomEvent(document, 'keydown', this.handleKeydown.bind(this));

		// Wheel:
		// - Ctrl/Cmd + wheel => zoom around cursor (panzoom.zoomWithWheel)
		// - Otherwise => navigate images
		this.registerDomEvent(this.displayAreaEl, 'wheel', (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				this.panzoom?.zoomWithWheel(e, {
				});
				const scale = this.panzoom.getScale();
				if(scale <= 1) {
					this.panzoom.setOptions({ disablePan: true, cursor: 'default' });
					this.panzoom.reset();
					this.panzoom.zoom(scale, { animate: false })
				} else {
					this.panzoom.setOptions({ disablePan: false, cursor: 'grab' });
				}
				return;
			}
			void this.navigateImage(e.deltaY > 0 ? 1 : -1);
		}, { passive: false });

		// Double click => reset pan/zoom
		this.registerDomEvent(this.displayAreaEl, 'dblclick', () => this.panzoom?.reset());

		// Disable native drag image behavior
		this.registerDomEvent(this.displayAreaEl, 'dragstart', (e: DragEvent) => e.preventDefault());

		// Thumbnails horizontal scroll
		this.registerDomEvent(this.thumbnailStrip, 'wheel', (e: WheelEvent) => {
			if (e.deltaY !== 0) {
				this.thumbnailStrip.scrollLeft += e.deltaY;
				e.preventDefault();
			}
		}, { passive: false });
	    this.registerDomEvent(this.displayAreaEl, 'touchstart', 
	        (e: TouchEvent) => this.handleSwipeStart(e), { passive: false });
	    this.registerDomEvent(this.displayAreaEl, 'touchmove', 
	        (e: TouchEvent) => this.handleTouchBlock(e), { passive: false });
	    this.registerDomEvent(this.displayAreaEl, 'touchend', 
	        (e: TouchEvent) => this.handleSwipeEnd(e), { passive: false });
	    this.registerDomEvent(this.displayAreaEl, 'touchcancel', 
	        (e: TouchEvent) => this.handleTouchBlock(e), { passive: false });
	}

	private handleTouchBlock(e: TouchEvent): void {
	        e.stopPropagation();
	        e.preventDefault();
	}

	// Keyboard navigation
	private handleKeydown(event: KeyboardEvent): void {
		if (!this.containerEl.isShown()) return;

		switch(event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				void this.navigateImage(-1);
				break;
			case 'ArrowRight':
				event.preventDefault();
				void this.navigateImage(1);
				break;
		}
	}
	private handleSwipeStart(e: TouchEvent): void {
		if (e.touches.length !== 1) return;
		if (this.panzoom?.getScale() > 1.0) return; // Zoomed - no swipe
		this.handleTouchBlock(e);

		this.swipeStartX = e.touches[0].clientX;
		this.swipeStartTime = Date.now();
	}

	private handleSwipeEnd(e: TouchEvent): void {
		if (e.changedTouches.length !== 1) return;
		if (this.panzoom?.getScale() > 1.0) return; // Zoomed - no swipe
		if (e.type === 'touchcancel') return;
		this.handleTouchBlock(e);

		const deltaX = e.changedTouches[0].clientX - this.swipeStartX;
		const deltaTime = Date.now() - this.swipeStartTime;

		// Быстрый горизонтальный свайп
		if (deltaTime < this.SWIPE_MAX_TIME && 
			Math.abs(deltaX) > this.SWIPE_THRESHOLD) {
			if (deltaX > 0) {
				void this.showPrevImage(); // Свайп вправо ← предыдущее
			} else {
				void this.showNextImage(); // Свайп влево → следующее
			}
		}
	}

	async loadImage(imageFile: TFile): Promise<void> {
		this.file = imageFile;
		this.mainImageEl.src = this.app.vault.getResourcePath(imageFile);
		this.mainImageEl.alt = imageFile.name;
		this.leaf.tabHeaderInnerTitleEl?.setText(imageFile.basename);

		// Дождаться декодирования, чтобы Panzoom видел корректные размеры
		try {
			await this.mainImageEl.decode();
		} catch (_) {
			// decode() может быть недоступен/упасть на некоторых форматах
		}

		await this.updateImageList(imageFile);
		await this.updateThumbnails();
		this.panzoom?.reset({ animate: false });
	}

	private async openInThisLeaf(file: TFile): Promise<void> {
		await this.leaf.openFile(file, { active: false });
	}

	// Получаем все изображения в папке текущего файла
	async updateImageList(currentFile: TFile): Promise<void> {
		if (!currentFile?.parent) return;

		this.imageList = this.app.vault.getFiles()
			.filter(file => 
				file.parent?.path === currentFile.parent.path && 
				IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())
			).sort((a, b) => a.name.localeCompare(b.name));

		this.currentIndex = this.imageList.findIndex(file => file.path === currentFile.path);
	}

	private async navigateImage(direction: -1 | 1): Promise<void> {
		if (this.imageList.length === 0) return;

		const newIndex = this.currentIndex + direction;
		if (newIndex >= 0 && newIndex < this.imageList.length) {
			await this.openInThisLeaf(this.imageList[newIndex]);
		}
	}

	async showPrevImage(): Promise<void> {
		await this.navigateImage(-1);
	}

	async showNextImage(): Promise<void> {
		await this.navigateImage(1);
	}

	// Создание миниатюр (базовая версия)
	async updateThumbnails(): Promise<void> {
		if (!this.thumbnailStrip) return;

		this.thumbnailStrip.empty();

		this.imageList.forEach((imgFile, index) => {
			const isActive = index === this.currentIndex;
			const thumbWrapper = this.thumbnailStrip.createEl('div', {
				cls: `thumbnail-wrapper ${isActive ? 'active' : ''}`,
				attr: { 'data-index': index.toString() }
			});

			const thumb = thumbWrapper.createEl('img', {
				cls: 'thumbnail',
				attr: {
					src: this.app.vault.getResourcePath(imgFile),
					alt: imgFile.basename
				}
			});

			// Обработчик клика на миниатюру
			if (index !== this.currentIndex) {
				this.registerDomEvent(thumb, 'click', () => this.openInThisLeaf(imgFile));
			}
		});
		this.scrollToActiveThumbnail();
	}

	private scrollToActiveThumbnail(): void {
		if (this.currentIndex < 0) return;
		
		const activeThumb = this.thumbnailStrip.querySelector(`.thumbnail-wrapper[data-index="${this.currentIndex}"]`);
		if (activeThumb) {
			activeThumb.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'center'
			});
		}
	}

	async onClose() {
		// На всякий случай освобождаем ресурсы panzoom
		(this.panzoom as any)?.destroy?.();
		this.panzoom = undefined;
	}
}