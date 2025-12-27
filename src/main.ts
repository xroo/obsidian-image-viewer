import { App, Plugin, TFile } from 'obsidian';
import { FileView, WorkspaceLeaf } from 'obsidian';

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
	private imageList: TFile[] = []; // Список изображений в текущей папке
	private currentIndex: number = -1; // Индекс текущего изображения

	private domBuilt = false;

	// Image Zoom and Drag Fields
	private zoomLevel: number = 1.0;
	private maxZoom: number = 5.0;
	private minZoom: number = 0.2;
	private zoomStep: number = 0.1;
	private isDragging: boolean = false;
	private dragStartX: number = 0;
	private dragStartY: number = 0;
	private translateX: number = 0;
	private translateY: number = 0;

	getViewType()                    { return VIEW_TYPE_IMAGE; }
	getDisplayText(): string         { return 'Image Viewer'; }
	getIcon(): string                { return 'images'; }
	constructor(leaf: WorkspaceLeaf) { super(leaf); }
	canAcceptExtension(extension: string): boolean {
 		return IMAGE_EXTENSIONS.includes(extension.toLowerCase());
	}

    async onLoadFile(file: TFile): Promise<void> {
    	if (!this.domBuilt) { this.buildDom(); }
		await this.loadImage(file);
	}

	private buildDom(): void {
		const container = this.contentEl;
		container.empty();

		const wrapper = container.createEl('div', { cls: 'image-gallery-container' });
		this.displayAreaEl = wrapper.createEl('div', { cls: 'image-display-area' });
		this.mainImageEl = this.displayAreaEl.createEl('img', { 
			cls: 'main-image',
			attr: { src: '' }
		});
		this.mainImageEl.style.transformOrigin = 'center center';
		this.thumbnailStrip = wrapper.createEl('div', { cls: 'thumbnail-strip' });
		this.bindEventListeners();

		this.domBuilt = true;
	}

	private bindEventListeners(): void {

		this.registerDomEvent(document, 'keydown', this.handleKeydown.bind(this));
		this.registerDomEvent(document, 'mousemove', (e: MouseEvent) => this.doDrag(e));
		this.registerDomEvent(document, 'mouseup', () => this.stopDrag());

		this.registerDomEvent(this.displayAreaEl, 'wheel', (e: WheelEvent) => this.handleZoom(e), { passive: false });
		this.registerDomEvent(this.displayAreaEl, 'mousedown', (e: MouseEvent) => this.startDrag(e));
		this.registerDomEvent(this.displayAreaEl, 'dblclick', () => this.resetZoom());
		this.registerDomEvent(this.displayAreaEl, 'dragstart', (e: DragEvent) => e.preventDefault());


		// Thumbnails horizontal scroll
		this.registerDomEvent(this.thumbnailStrip, 'wheel', (e: WheelEvent) => {
			if (e.deltaY !== 0) {
				this.thumbnailStrip.scrollLeft += e.deltaY;
				e.preventDefault();
			}
		}, { passive: false });
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
	async loadImage(imageFile: TFile): Promise<void> {
		this.file = imageFile;
		this.mainImageEl.src = this.app.vault.getResourcePath(imageFile);
		this.mainImageEl.alt = imageFile.name;

		this.leaf.tabHeaderInnerTitleEl?.setText(imageFile.basename);

		await this.updateImageList(imageFile);
		await this.updateThumbnails();
		this.resetZoom();
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

	// Обработка колесика мыши
	handleZoom(event: WheelEvent): void {
		if (!(event.ctrlKey || event.metaKey)) {
			void this.navigateImage(event.deltaY > 0 ? 1 : -1);
			return;
		}

		// Ctrl/Cmd + Wheel = Zoom, else - navigation
		event.preventDefault();
		const delta = Math.sign(event.deltaY) > 0 ? -1 : 1;
		const zoomOld = this.zoomLevel;
		this.zoomLevel = Math.max(
			this.minZoom,
			Math.min(this.maxZoom, this.zoomLevel + delta * this.zoomStep)
		);

		// Zoom
		const rect = this.displayAreaEl.getBoundingClientRect();
		const clientX = - (event.clientX - (rect.left + rect.width/2 + this.translateX));
		const clientY = - (event.clientY - (rect.top + rect.height/2 + this.translateY));
		this.translateX = (this.translateX + clientX * (this.zoomLevel / zoomOld - 1));
		this.translateY = (this.translateY + clientY * (this.zoomLevel / zoomOld - 1));

		this.applyZoom();
	}

	// Применение зума к изображению
	private applyZoom(): void {
		if (this.zoomLevel <= 1.0) {
			this.translateX = this.translateY = 0;
		}

		const transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.zoomLevel})`;
		this.mainImageEl.style.transform = transform;
	    // Показываем курсор "рука" при зуме > 100%
		this.mainImageEl.style.cursor = this.zoomLevel > 1.0 ? 'grab' : 'default';

	}

	// Сброс зума (например, по двойному клику)
	resetZoom(): void {
		this.zoomLevel = 1.0;
		this.translateX = this.translateY = 0;
		this.applyZoom();
	}

	// Методы для перетаскивания зуммированного изображения
	private startDrag(event: MouseEvent): void {
		if (this.zoomLevel <= 1.0) return;

		this.isDragging = true;
		this.dragStartX = event.clientX - this.translateX;
		this.dragStartY = event.clientY - this.translateY;
		this.mainImageEl.style.cursor = 'grabbing';
	}
	private doDrag(event: MouseEvent): void {
		if (!this.isDragging || this.zoomLevel <= 1.0) return;

		this.translateX = event.clientX - this.dragStartX;
		this.translateY = event.clientY - this.dragStartY;
		this.applyZoom();
	}
	private stopDrag(): void {
		this.isDragging = false;
		if (this.mainImageEl && this.zoomLevel > 1.0) {
			this.mainImageEl.style.cursor = 'grab';
		}
	}
}